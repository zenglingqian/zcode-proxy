// login-manager.js — ZCode CLI 登录向导封装
//
// 流程：spawn `zcode login <family> --no-browser` → 从 stdout 捕获授权 URL →
//       自动打开系统浏览器（同时在管理页展示链接）→ 轮询凭据文件中 zcodejwttoken
//       出现/变化（或登录进程退出码 0）→ 成功；5 分钟超时。
// 同一时间只允许一个登录会话。

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { getCredentialState, ensureCredentialCache, ensureKeyringShimFiles, resolveDataRoot } = require('./engine');

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** 与 engine.js 相同规则：显式给 login 子进程注入数据根、内置 provider 配置路径与 keyring 钩子 */
function loginChildEnv(zcodeExe, runtimeDir, log) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZCODE_DATA_BASE_DIR: resolveDataRoot() };
  try {
    if (zcodeExe) {
      const candidate = path.join(path.dirname(zcodeExe), 'resources', 'config', 'provider', 'zcode-builtin.json');
      if (fs.existsSync(candidate)) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = candidate;
    }
    const preload = ensureKeyringShimFiles(path.join(runtimeDir || '.', 'engine-logs'), zcodeExe, log);
    if (preload) {
      env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require "${preload.split(String.fromCharCode(92)).join('/')}"`.trim();
      env.ZCODE_KEYRING_SHIM = path.join(path.join(runtimeDir || '.', 'engine-logs'), 'zcode-keyring-shim.mjs');
    }
  } catch { /* best-effort */ }
  return env;
}

class LoginManager {
  constructor() {
    this.session = null; // {id, family, state, url, message, startedAt, _child, _snapshotJwt, _timer}
  }

  /**
   * 启动一次登录。
   * @param {string} family 'zai' | 'bigmodel'
   * @param {object} opts {zcodeExe, zcodeCjs, openBrowser(function(url)), log(function)}
   */
  start(family, opts) {
    if (family !== 'zai' && family !== 'bigmodel') {
      return { ok: false, error: `不支持的账号体系: ${family}` };
    }
    if (this.session && (this.session.state === 'waiting')) {
      return { ok: false, error: '已有登录流程进行中，请先完成或等待超时' };
    }
    const { zcodeExe, zcodeCjs, openBrowser, log = () => {} } = opts;

    // 记录登录前的 JWT 快照（登录成功 = JWT 出现或发生变化）
    const before = getCredentialState();
    let beforeRaw = null;
    try { beforeRaw = require('node:fs').readFileSync(before.file, 'utf8'); } catch { /* 无文件 */ }

    const session = {
      id: 'login-' + Date.now(),
      family,
      state: 'waiting',
      url: null,
      message: '正在发起授权…',
      startedAt: Date.now(),
      _log: log,
      _snapshot: beforeRaw,
    };
    this.session = session;

    const child = spawn(zcodeExe, [zcodeCjs, 'login', family, '--no-browser'], {
      env: loginChildEnv(zcodeExe, opts.runtimeDir, log),
      windowsHide: true,
    });
    session._child = child;

    let stdoutBuf = '';
    let stderrTail = '';
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      if (!session.url) {
        const m = stdoutBuf.match(/https:\/\/\S+/);
        if (m) {
          session.url = m[0];
          session.message = '请在浏览器中完成授权…';
          log(`[login] 授权链接已生成（${family}），正在打开浏览器`);
          try { openBrowser?.(session.url); } catch (err) { log(`[login] 打开浏览器失败（可在管理页手动点击链接）: ${err.message}`); }
        }
      }
    });
    child.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) {
        stderrTail = (stderrTail + '\n' + t).slice(-1000);
        log(`[login:stderr] ${t.split(/\r?\n/).slice(-1)[0].slice(0, 200)}`);
        try {
          const dir = opts.runtimeDir || '.';
          const fd = fs.openSync(path.join(dir, 'engine-logs', 'login-stderr.log'), 'a');
          fs.writeSync(fd, t + '\n');
          fs.closeSync(fd);
        } catch { /* ignore */ }
      }
    });

    const finish = (state, message) => {
      if (session.state !== 'waiting') return;
      session.state = state;
      // 失败时附带真实报错（stderr 末行），供界面直接展示原因
      if (state === 'failed') {
        const tail = stderrTail.trim();
        // 已知硬限制：无头 CLI 登录需要桌面会话的官方凭据 broker（envForSession 动态生成），
        // 缺失即报 "System credential storage is unavailable" —— 只能在 ZCode 桌面版里登录
        if (/System credential storage is unavailable/i.test(tail)) {
          message = 'ZCode 无头登录受系统凭据库限制，无法在此直接登录账号。请在 ZCode 桌面版中登录该账号（桌面版 → 设置/账号），登录成功后本代理会自动读取新凭据并恢复，无需任何操作。';
        } else {
          const errLine = tail.split(/\r?\n/).filter(Boolean).slice(-1)[0];
          if (errLine) message += `：${errLine.slice(0, 200)}`;
        }
      }
      session.message = message;
      clearTimeout(session._timer);
      log(`[login] ${family} 登录流程结束: ${state}`);
    };

    // 成功判定①：进程退出码 0
    child.on('exit', (code) => {
      if (code === 0) finish('success', '登录成功');
      else if (session.state === 'waiting') finish('failed', `登录进程退出（码 ${code}），请重试或查看服务日志`);
    });

    // 成功判定②：凭据文件里的 JWT 出现/变化（进程可能还没退出就已写好凭据）
    session._poll = setInterval(() => {
      const now = getCredentialState();
      let nowRaw = null;
      try { nowRaw = require('node:fs').readFileSync(now.file, 'utf8'); } catch { /* ignore */ }
      if (now.hasJwt && nowRaw !== session._snapshot) {
        try { child.kill(); } catch { /* ignore */ }
        finish('success', '登录成功（凭据已写入）');
      }
    }, 1500);

    // 超时
    session._timer = setTimeout(() => {
      if (session.state === 'waiting') {
        try { child.kill(); } catch { /* ignore */ }
        finish('timeout', '授权超时（5 分钟），请重新发起登录');
      }
    }, LOGIN_TIMEOUT_MS);

    return { ok: true, loginId: session.id, family };
  }

  status() {
    if (!this.session) return { state: 'idle', message: '尚未发起登录' };
    const { id, family, state, url, message, startedAt } = this.session;
    return { id, family, state, url, message, startedAt };
  }

  cancel() {
    if (this.session && this.session.state === 'waiting') {
      try { this.session._child?.kill(); } catch { /* ignore */ }
      clearInterval(this.session._poll);
      this.session.state = 'cancelled';
      this.session.message = '已取消';
    }
  }
}

/** 用系统默认浏览器打开 URL（explorer 不经过 cmd，URL 中的 & 等字符安全） */
function openInBrowser(url) {
  const { spawn } = require('node:child_process');
  spawn('explorer', [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

module.exports = { LoginManager, openInBrowser };
