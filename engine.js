// engine.js — 常驻 ZCode 引擎（app-server 模式）封装
//
// 架构（与 ZCode 桌面版驱动引擎的方式一致）：
//   1. spawn `zcode app-server --stdio`（长驻进程，协议为 ZCode Protocol：NDJSON {id?,method,params/result}）
//   2. 从引擎日志提取 builtin revision，推送 provider/updateAccountConfig 账号快照
//      （把 builtin 里的 start-plan 等账号 provider 标记为 entitled），使无头模式下可用桌面版同款订阅
//   3. 会话内反向请求由本端应答：
//        session/requestRuntimePreferences            → 运行时偏好
//        interaction/requestProviderRuntimeHeaders    → 注入 X-ZCode-Authorization JWT（读共享凭据库）
//   4. 每次对话：session/create(或 resume) → session/subscribe → session/send →
//      消费 session/event 通知（text_delta / reasoning_delta / turn.completed / turn.failed）

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const ENC_PREFIX = 'enc:v1:';

// ---------- 共享凭据库读取（与 CLI 同规则：ZCODE_DATA_BASE_DIR > homedir） ----------

function dataBaseDir(env = process.env) {
  const fromEnv = env.ZCODE_DATA_BASE_DIR && env.ZCODE_DATA_BASE_DIR.trim();
  return fromEnv || os.homedir();
}

/**
 * 数据根解析（健壮版）：
 *   ① 进程环境变量 ZCODE_DATA_BASE_DIR（桌面版子进程场景）
 *   ② 用户级注册表环境变量（若用户曾持久化设置）
 *   ③ 桌面版 setting.json 的 dataBaseDir 字段（权威指针：桌面版把真实数据根写在这里）
 *   ④ 用户主目录（ZCode 默认）
 * 双击启动的安装版没有桌面注入的环境变量，靠 ③ 找到真实数据根。
 */
let _dataRootCache = null;
function resolveDataRoot(env = process.env) {
  if (_dataRootCache) return _dataRootCache;
  const fromEnv = env.ZCODE_DATA_BASE_DIR && env.ZCODE_DATA_BASE_DIR.trim();
  if (fromEnv) return (_dataRootCache = fromEnv);
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'ZCODE_DATA_BASE_DIR'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const m = out.match(/ZCODE_DATA_BASE_DIR\s+REG_SZ\s+(.+)/);
    if (m && m[1].trim()) return (_dataRootCache = m[1].trim());
  } catch { /* 未持久化设置，继续 */ }
  try {
    const settingFile = path.join(os.homedir(), '.zcode', 'v2', 'setting.json');
    const setting = JSON.parse(fs.readFileSync(settingFile, 'utf8'));
    const db = typeof setting.dataBaseDir === 'string' && setting.dataBaseDir.trim();
    if (db) return (_dataRootCache = db);
  } catch { /* 无 setting.json，继续 */ }
  return (_dataRootCache = os.homedir());
}

function credentialSecret(env = process.env) {
  const explicit = env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET.trim();
  if (explicit) return explicit;
  let username = 'unknown';
  try { username = os.userInfo().username; } catch { /* ignore */ }
  return `zcode-credential-fallback:${process.platform}:${os.homedir()}:${username}`;
}

function decryptCredentialValue(value, env) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split('.');
  const key = crypto.createHash('sha256').update(credentialSecret(env)).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

// ---------- v2 系统密钥环解密（enc:v2:os，桌面版热更新后启用） ----------

let _keyringMod = null;
function nativeKeyring(zcodeExe, log) {
  if (_keyringMod !== null) return _keyringMod;
  try {
    if (!zcodeExe) throw new Error('未知 ZCode 路径');
    const nativePath = path.join(
      path.dirname(zcodeExe), 'resources', 'app.asar.unpacked', 'node_modules',
      '@napi-rs', 'keyring-win32-x64-msvc', 'keyring.win32-x64-msvc.node',
    );
    _keyringMod = require(nativePath);
  } catch (err) {
    _keyringMod = false; // 记住失败，避免反复加载
    log?.(`[cred] keyring 原生模块不可用: ${err.message}`);
  }
  return _keyringMod || null;
}

const V2_RE = /^enc:v2:(os):([0-9a-f]{24}):(.+)$/;

/** 解密 enc:v2:os 值：密钥在 Windows 凭据管理器（service = "ZCode Credential Encryption"） */
async function v2Decrypt(value, credPath, zcodeExe, log) {
  const m = value.match(V2_RE);
  if (!m) throw new Error('非 enc:v2 格式');
  const [, , fp, blob] = m;
  const mod = nativeKeyring(zcodeExe, log);
  if (!mod || !mod.Entry) throw new Error('keyring 原生模块不可用（无法读取系统凭据存储）');
  const account = crypto.createHash('sha256').update(path.resolve(credPath)).digest('hex');
  const entry = new mod.Entry('ZCode Credential Encryption', account);
  const secret = entry.getPassword();
  if (!secret) throw new Error('系统密钥环中未找到本机凭据加密密钥');
  const key = Buffer.from(secret, 'base64url');
  const realFp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  if (realFp !== fp) throw new Error(`密钥指纹不匹配（${realFp} ≠ ${fp}）`);
  const [iv, tag, data] = blob.split('.').map((x) => Buffer.from(x, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function decryptAny(value, credPath, zcodeExe, env, log) {
  if (typeof value !== 'string' || !value) return '';
  if (value.startsWith('enc:v2:')) return v2Decrypt(value, credPath, zcodeExe, log);
  return decryptCredentialValue(value, env);
}

// ---------- 凭据缓存（异步解密一次，同步读取） ----------

const _credCache = { mtimeMs: -1, loaded: false, jwt: '', names: {}, activeProvider: null, file: null, fileExists: false };

/**
 * 刷新凭据缓存：文件 mtime 变化或缓存为空时重新解密。
 * 引擎启动、回答运行时头、账号状态查询前调用。
 */
async function ensureCredentialCache(zcodeExe, log) {
  const file = path.join(resolveDataRoot(), '.zcode', 'v2', 'credentials.json');
  _credCache.file = file;
  let cred = null;
  let mtimeMs = -1;
  try {
    const stat = fs.statSync(file);
    mtimeMs = stat.mtimeMs;
    cred = JSON.parse(fs.readFileSync(file, 'utf8'));
    _credCache.fileExists = true;
  } catch {
    _credCache.fileExists = false;
    _credCache.jwt = '';
    return _credCache;
  }
  if (cred && _credCache.loaded && mtimeMs === _credCache.mtimeMs && _credCache.jwt) return _credCache;
  _credCache.mtimeMs = mtimeMs;
  try {
    _credCache.jwt = await decryptAny(cred.zcodejwttoken, file, zcodeExe, process.env, log);
  } catch (err) {
    _credCache.jwt = '';
    log?.(`[cred] 读取 JWT 失败: ${err.message}`);
  }
  for (const family of ['zai', 'bigmodel']) {
    try {
      const raw = cred[`oauth:${family}:user_info`];
      const info = raw ? JSON.parse(await decryptAny(raw, file, zcodeExe, process.env, log)) : null;
      _credCache.names[family] = info ? (info.name || info.username || info.email || null) : null;
    } catch { _credCache.names[family] = null; }
  }
  try {
    _credCache.activeProvider = cred['oauth:active_provider']
      ? await decryptAny(cred['oauth:active_provider'], file, zcodeExe, process.env, log)
      : null;
  } catch { _credCache.activeProvider = null; }
  _credCache.loaded = true;
  return _credCache;
}

function readZcodeJwt() {
  return _credCache.jwt || '';
}

function getCredentialCache() {
  return _credCache;
}

/** 凭据连接状态（管理台展示用）：不打印敏感值，只回报有无与来源 */
function getCredentialState() {
  const file = path.join(resolveDataRoot(), '.zcode', 'v2', 'credentials.json');
  const c = _credCache;
  return { file, hasJwt: Boolean(c.jwt), fileExists: Boolean(c.fileExists), activeProvider: c.activeProvider };
}

/** 在本机探测 ZCode 安装路径（config 留空时使用） */
function resolveZcodePaths(env = process.env) {
  const fsSyncExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  const candidates = [
    env.ZCODE_INSTALL_DIR,
    'D:\\Program Files\\ZCode',
    'C:\\Program Files\\ZCode',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode'),
    path.join(os.homedir(), 'AppData', 'Local', 'ZCode'),
  ];
  for (const dir of candidates) {
    if (!dir || !dir.trim()) continue;
    const exe = path.join(dir, 'ZCode.exe');
    const cjs = path.join(dir, 'resources', 'glm', 'zcode.cjs');
    if (fsSyncExists(exe) && fsSyncExists(cjs)) return { zcodeExe: exe, zcodeCjs: cjs, source: dir };
  }
  // 注册表卸载信息兜底（电子打包应用常见）
  try {
    const { execFileSync } = require('node:child_process');
    for (const hive of ['HKCU', 'HKLM']) {
      let out = '';
      try {
        out = execFileSync('reg', [
          'query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
          '/s', '/f', 'ZCode.exe', '/d',
        ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      } catch { continue; }
      const iconMatch = out.match(/DisplayIcon\s+REG_\w+\s+(.+ZCode\.exe)/i);
      if (iconMatch) {
        const dir = path.dirname(iconMatch[1]);
        const exe = path.join(dir, 'ZCode.exe');
        const cjs = path.join(dir, 'resources', 'glm', 'zcode.cjs');
        if (fsSyncExists(exe) && fsSyncExists(cjs)) return { zcodeExe: exe, zcodeCjs: cjs, source: dir };
      }
    }
  } catch { /* best-effort */ }
  return null;
}

// ---------- 引擎 ----------

const _shimFiles = { preload: null };
/** 写入（一次）keyring 加载钩子三件套，返回 preload 路径（供引擎与 login 子进程共用） */
function ensureKeyringShimFiles(dir, zcodeExe, log) {
  if (_shimFiles.preload && fs.existsSync(_shimFiles.preload)) return _shimFiles.preload;
  try {
    const nativePath = path.join(
      path.dirname(zcodeExe), 'resources', 'app.asar.unpacked', 'node_modules',
      '@napi-rs', 'keyring-win32-x64-msvc', 'keyring.win32-x64-msvc.node',
    );
    if (!fs.existsSync(nativePath)) return null;
    fs.mkdirSync(dir, { recursive: true });
    const shimFile = path.join(dir, 'zcode-keyring-shim.mjs');
    fs.writeFileSync(
      shimFile,
      "import { createRequire } from 'node:module';\n"
      + 'const require = createRequire(import.meta.url);\n'
      + `const native = require(${JSON.stringify(nativePath)});\n`
      + 'export const Entry = native.Entry;\n'
      + 'export const AsyncEntry = native.AsyncEntry;\n'
      + 'export const findCredentials = native.findCredentials;\n'
      + 'export const findCredentialsAsync = native.findCredentialsAsync;\n'
      + 'export default native;\n',
      'utf8',
    );
    const hookFile = path.join(dir, 'zcode-keyring-hook.mjs');
    fs.writeFileSync(
      hookFile,
      "import { pathToFileURL } from 'node:url';\n"
      + 'export async function resolve(specifier, context, next) {\n'
      + "  if (specifier === '@napi-rs/keyring') {\n"
      + '    return { url: pathToFileURL(process.env.ZCODE_KEYRING_SHIM).href, format: "module", shortCircuit: true };\n'
      + '  }\n'
      + '  return next(specifier, context);\n'
      + '}\n',
      'utf8',
    );
    const preloadFile = path.join(dir, 'zcode-keyring-preload.cjs');
    fs.writeFileSync(
      preloadFile,
      'try {\n'
      + "  const { register } = require('node:module');\n"
      + "  const { pathToFileURL } = require('node:url');\n"
      + "  register(pathToFileURL(__dirname + '/zcode-keyring-hook.mjs').href);\n"
      + '} catch {}\n',
      'utf8',
    );
    _shimFiles.preload = preloadFile;
    return preloadFile;
  } catch (err) {
    log?.(`[engine] 写入 keyring 钩子失败: ${err.message}`);
    return null;
  }
}
class ZcodeEngine {
  /**
   * @param {object} opts
   *   zcodeExe, zcodeCjs, log(function), engineLogDir(string)
   */
  constructor(opts) {
    this.zcodeExe = opts.zcodeExe;
    this.zcodeCjs = opts.zcodeCjs;
    this.log = opts.log || (() => {});
    this.engineLogDir = opts.engineLogDir;
    this.child = null;
    this.buf = '';
    this.pending = new Map(); // id -> resolve
    this.nextId = 1;
    this.builtinRevision = null;
    this.eventListeners = new Set(); // fn(notification)
    this.exited = null;
  }

  writeKeyringShims() {
    return ensureKeyringShimFiles(this.engineLogDir, this.zcodeExe, this.log);
  }

  /** 启动引擎并完成账号快照推送；返回即表示引擎可用 */
  async start() {
    if (this.child) return;
    if (this.engineLogDir) fs.mkdirSync(this.engineLogDir, { recursive: true });

    // 记录日志基线（字节偏移）：只认本次引擎新写入的内容，避免扫到历史运行的旧 revision
    this._logBaseline = {};
    try {
      for (const f of fs.readdirSync(this.engineLogDir).filter((x) => x.endsWith('.jsonl'))) {
        this._logBaseline[f] = fs.statSync(path.join(this.engineLogDir, f)).size;
      }
    } catch { /* 目录为空则全量扫描 */ }

    // 内置 provider 配置：引擎自身的定位逻辑在本机布局下会失败（resources\config 不在它的候选路径里），
    // 显式指给引擎（存在时才设置，避免破坏其他布局）
    let builtinConfigFile = '';
    if (this.zcodeExe) {
      const candidate = path.join(path.dirname(this.zcodeExe), 'resources', 'config', 'provider', 'zcode-builtin.json');
      if (fs.existsSync(candidate)) builtinConfigFile = candidate;
    }

    // keyring 加载钩子：让引擎子进程能解密 enc:v2 凭据（桌面版热更新后启用）
    const keyringPreload = this.writeKeyringShims();
    const keyringEnv = keyringPreload
      ? {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${keyringPreload.split(String.fromCharCode(92)).join('/')}"`.trim(),
          ZCODE_KEYRING_SHIM: path.join(this.engineLogDir, 'zcode-keyring-shim.mjs'),
        }
      : {};

    this.child = spawn(this.zcodeExe, [this.zcodeCjs, 'app-server', '--stdio'], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // 显式注入数据根：不依赖 shell 环境变量继承（双击启动/服务化可能丢失）
        ZCODE_DATA_BASE_DIR: resolveDataRoot(),
        ...(builtinConfigFile ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfigFile } : {}),
        ...keyringEnv,
        ...(this.engineLogDir ? { ZCODE_LOG_DIR: this.engineLogDir } : {}),
      },
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.log(`[engine] 引擎进程退出 code=${code} signal=${signal}`);
        this.child = null;
        // 唤醒所有挂起请求
        for (const [id, p] of this.pending) p.reject?.(new Error('引擎进程已退出'));
        this.pending.clear();
        resolve({ code, signal });
      });
    });
    this.child.on('error', (err) => {
      this.log(`[engine] 引擎进程错误: ${err.message}`);
    });
    this._stderrTail = '';
    try {
      this._stderrFile = path.join(this.engineLogDir, 'engine-stderr.log');
      this._stderrFd = fs.openSync(this._stderrFile, 'w');
    } catch { this._stderrFd = null; }
    this.child.stderr.on('data', (d) => {
      const t = d.toString();
      if (this._stderrFd !== null) { try { fs.writeSync(this._stderrFd, t); } catch { /* ignore */ } }
      const trimmed = t.trim();
      if (trimmed) {
        this._stderrTail = (this._stderrTail + '\n' + trimmed).slice(-2000);
        this.log(`[engine:stderr] ${trimmed.split(/\r?\n/).slice(-2).join(' | ').slice(0, 500)}`);
      }
    });

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));

    // 预热凭据缓存（JWT + 账号名），运行时头注入直接取缓存
    await ensureCredentialCache(this.zcodeExe, this.log);

    // 等引擎日志出现 provider_registry.ready，提取 builtin revision；引擎提前退出则快速失败
    try {
      await this.waitBuiltinRevision(30000);
      if (!this.builtinRevision) {
        const tail = (this._stderrTail || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        throw new Error(`未能从引擎日志取得 builtin revision（provider_registry.ready）${tail ? `；引擎 stderr: ${tail}` : ''}`);
      }
      await this.pushAccountSnapshot();
    } catch (err) {
      // 启动失败必须清掉子进程，否则 ZCode.exe 泄漏且可能持锁阻碍下一次启动
      this.log(`[engine] 启动失败: ${err.message}`);
      try { this.child?.kill(); } catch { /* ignore */ }
      if (this.child?.pid && process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
      }
      this.child = null;
      throw err;
    }
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { return; }
    // 服务端反向请求
    if (ev.method && ev.id !== undefined && ev.result === undefined && ev.error === undefined) {
      this.handleServerRequest(ev);
      return;
    }
    // 通知
    if (ev.method) {
      for (const fn of this.eventListeners) {
        try { fn({ method: ev.method, params: ev.params }); } catch (err) { this.log(`[engine] 事件监听器异常: ${err.message}`); }
      }
      return;
    }
    // 响应
    const p = this.pending.get(ev.id);
    if (p) {
      this.pending.delete(ev.id);
      if (ev.error) p.reject(Object.assign(new Error(ev.error.message || '引擎请求失败'), { rpcError: ev.error }));
      else p.resolve(ev.result);
    }
  }

  /** 引擎→客户端 的反向请求 */
  handleServerRequest(ev) {
    switch (ev.method) {
      case 'session/requestRuntimePreferences':
        this.respond(ev.id, { nativeSearchEnhancementsEnabled: false });
        break;
      case 'interaction/requestProviderRuntimeHeaders': {
        // 先刷新凭据缓存（文件可能刚被桌面版刷新），再应答
        ensureCredentialCache(this.zcodeExe, this.log)
          .then(() => {
            const jwt = readZcodeJwt();
            if (!jwt) {
              this.respond(ev.id, { headersApplied: false, errorMessage: '代理未能读取 ZCode JWT（共享凭据库为空或解密失败）。请在 ZCode 桌面版重新登录一次。' });
              this.log('[engine] 警告：未能读取 JWT，模型请求将被拒绝');
              return;
            }
            this.respond(ev.id, {
              headersApplied: true,
              requestAuth: {
                apiKey: jwt,
                headers: { 'X-ZCode-Authorization': `Bearer ${jwt}` },
              },
            });
          })
          .catch((err) => this.respond(ev.id, { headersApplied: false, errorMessage: `读取凭据失败: ${err.message}` }));
        break;
      }
      default:
        // 未支持的交互请求（如 officialMcpAuthHeaders）：显式拒绝，避免引擎挂起等待
        this.respondError(ev.id, -32002, `代理不支持该交互请求: ${ev.method}`);
        break;
    }
  }

  respond(id, result) {
    this.writeLine({ id, result });
  }

  respondError(id, code, message) {
    this.writeLine({ id, error: { code, message } });
  }

  writeLine(obj) {
    if (!this.child) throw new Error('引擎未启动');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, { timeoutMs = 120000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`引擎请求超时: ${method}`), { code: 'ENGINE_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.writeLine({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** 轮询引擎日志，等待 provider_registry.ready 并提取 builtin revision */
  async waitBuiltinRevision(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.builtinRevision) {
      // 引擎进程提前退出则立即失败，不做无谓等待
      if (!this.child || this.child.exitCode !== null) {
        throw new Error('引擎进程在启动阶段退出');
      }
      this.extractRevisionFromLogs();
      if (this.builtinRevision) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  extractRevisionFromLogs() {
    if (!this.engineLogDir) return;
    let files = [];
    try { files = fs.readdirSync(this.engineLogDir).filter((f) => f.endsWith('.jsonl')); } catch { return; }
    // 最新修改的文件优先（当前引擎写的是最新文件）
    files.sort((a, b) => {
      try {
        return fs.statSync(path.join(this.engineLogDir, b)).mtimeMs - fs.statSync(path.join(this.engineLogDir, a)).mtimeMs;
      } catch { return 0; }
    });
    for (const f of files) {
      const full = path.join(this.engineLogDir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const base = (this._logBaseline && this._logBaseline[f]) || 0;
      if (stat.size <= base) continue; // 该文件本次引擎无新增内容
      let content = '';
      try {
        const fh = fs.openSync(full, 'r');
        const buf = Buffer.alloc(stat.size - base);
        fs.readSync(fh, buf, 0, buf.length, base);
        fs.closeSync(fh);
        content = buf.toString('utf8');
      } catch { continue; }
      const appendedLines = content.split(/\r?\n/);
      for (let i = appendedLines.length - 1; i >= 0; i -= 1) {
        const line = appendedLines[i];
        if (!line.includes('provider_registry.ready')) continue;
        try {
          const j = JSON.parse(line);
          const ctx = j.context;
          const raw = ctx?.accountRevision;
          if (typeof raw !== 'string') continue;
          const inner = raw.startsWith('account:') ? raw.slice('account:'.length) : raw;
          const arr = JSON.parse(inner);
          if (typeof arr?.[0] === 'string') {
            this.builtinRevision = arr[0];
            this.log(`[engine] builtin revision: ${arr[0]}`);
            return;
          }
        } catch { /* ignore */ }
      }
    }
  }

  /** 推送账号快照：把 builtin 中的账号 provider 全部标记为 entitled（与桌面版登录状态一致） */
  async pushAccountSnapshot() {
    // builtin provider 声明（含 builtinModelIds）从安装目录读取
    const builtinFile = path.join(
      path.dirname(this.zcodeCjs), '..', 'config', 'provider', 'zcode-builtin.json',
    );
    let accountProviders = {};
    try {
      const builtin = JSON.parse(fs.readFileSync(builtinFile, 'utf8'));
      for (const rule of builtin.config?.providerConfigRules?.providerRules || []) {
        const access = rule.config?.access;
        if (access?.type === 'zhipu-account' && access.accountType && access.mode) {
          accountProviders[rule.providerId] = {
            builtinModelIds: rule.config.builtinModelIds || [],
            access: { type: 'zhipu-account', entitled: true },
          };
        }
      }
    } catch (err) {
      throw new Error(`读取内置 provider 配置失败 (${builtinFile}): ${err.message}`);
    }
    const providers = {};
    const states = {};
    for (const [id, entry] of Object.entries(accountProviders)) {
      providers[id] = entry;
      states[id] = { availability: 'available', entitled: true, current: true };
    }
    const snapshot = {
      revision: `zcode-proxy-${Date.now()}`,
      basedOnZCodeBuiltinRevision: this.builtinRevision,
      providers,
      states,
    };
    const r = await this.request('provider/updateAccountConfig', snapshot, { timeoutMs: 30000 });
    this.log(`[engine] 账号快照已推送: ${r.providerCount} 个 provider`);
    await this.request('provider/refreshRegistry', { reason: 'zcode-proxy-startup' }, { timeoutMs: 30000 });
  }

  // ---------- 会话操作 ----------

  /**
   * 创建会话。若报"Provider Registry 中不存在 Model"（引擎中途重建注册表导致快照失效），
   * 自动重新推送账号快照并重试一次。
   */
  async createSession(modelEntry, workspaceDir) {
    try {
      return await this._createSession(modelEntry, workspaceDir);
    } catch (err) {
      const msg = String(err?.message || err);
      if (!/不存在 Model/.test(msg)) throw err;
      // 自愈①：重新提取 revision + 重推快照
      this.log('[engine] 模型未注册，重推账号快照后重试');
      try { this.extractRevisionFromLogs(); } catch { /* ignore */ }
      await this.pushAccountSnapshot();
      try {
        return await this._createSession(modelEntry, workspaceDir);
      } catch (err2) {
        if (!/不存在 Model/.test(String(err2?.message || err2))) throw err2;
        // 自愈②：整引擎重启（全新 builtin revision / 注册表）
        this.log('[engine] 重推无效，重启引擎恢复注册表');
        await this.restart();
        return this._createSession(modelEntry);
      }
    }
  }

  async _createSession(modelEntry, workspaceDir) {
    // 工作区优先级：模型显式 cwd > 调用方传入的独立任务目录 > 进程目录
    const wsPath = modelEntry.cwd || workspaceDir || process.cwd();
    const params = {
      workspace: { workspacePath: wsPath, workspaceKey: wsPath },
      mode: modelEntry.mode || 'yolo',
      model: {
        providerId: modelEntry.providerId,
        modelId: modelEntry.modelId,
        ...(modelEntry.reasoningLevel ? { options: { reasoningLevel: modelEntry.reasoningLevel } } : {}),
      },
    };
    const r = await this.request('session/create', params, { timeoutMs: 120000 });
    return r.session?.sessionId ?? r.sessionId;
  }

  async resumeSession(sessionId) {
    await this.request('session/resume', { sessionId }, { timeoutMs: 120000 });
    return sessionId;
  }

  async subscribe(sessionId) {
    await this.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeoutMs: 30000 });
  }

  async send(sessionId, content, modelEntry, inputId) {
    const params = {
      sessionId,
      content,
      modelSelection: {
        providerId: modelEntry.providerId,
        modelId: modelEntry.modelId,
        ...(modelEntry.reasoningLevel ? { options: { reasoningLevel: modelEntry.reasoningLevel } } : {}),
      },
      ...(inputId ? { inputId } : {}),
    };
    return this.request('session/send', params, { timeoutMs: 60000 });
  }

  async stopTurn(sessionId) {
    try { await this.request('session/stop', { sessionId }, { timeoutMs: 15000 }); } catch { /* ignore */ }
  }

  async closeSession(sessionId) {
    try { await this.request('session/close', { sessionId }, { timeoutMs: 15000 }); } catch { /* ignore */ }
  }

  /** 订阅引擎的 session/event 通知 */
  onEvent(fn) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  isAlive() {
    return Boolean(this.child);
  }

  async restart() {
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
    this.pending.clear();
    this.builtinRevision = null;
    await new Promise((r) => setTimeout(r, 500));
    await this.start();
  }

  async dispose() {
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
    this.eventListeners.clear();
  }
}

// ---------- 单例管理 ----------

let singleton = null;

/**
 * 获取（或创建）常驻引擎。
 * @param {object} config 代理配置（zcodeExe/zcodeCjs/runtimeDir...）
 */
async function getEngine(config) {
  if (singleton && singleton.isAlive()) return singleton;
  if (singleton) await singleton.dispose().catch(() => {});
  singleton = new ZcodeEngine({
    zcodeExe: config.zcodeExe,
    zcodeCjs: config.zcodeCjs,
    log: config.log,
    engineLogDir: path.join(config.runtimeDir, 'engine-logs'),
  });
  try {
    await singleton.start();
  } catch (err) {
    await singleton.dispose().catch(() => {});
    singleton = null;
    throw err;
  }
  // 引擎意外退出时清空单例，下次请求自动重启
  singleton.exited.then(() => {
    if (singleton && !singleton.isAlive()) {
      config.log?.('[engine] 引擎已退出，将在下次请求时重启');
    }
  });
  return singleton;
}

/** 引擎是否已启动且存活（不触发启动） */
function isEngineAlive() {
  return Boolean(singleton && singleton.isAlive());
}

/** 停止并释放当前引擎（桌面应用退出时调用） */
async function disposeEngine() {
  if (singleton) {
    await singleton.dispose().catch(() => {});
    singleton = null;
  }
}

module.exports = { getEngine, isEngineAlive, disposeEngine, readZcodeJwt, getCredentialState, getCredentialCache, ensureCredentialCache, resolveZcodePaths, resolveDataRoot, decryptCredentialValue, decryptAny, dataBaseDir, ZcodeEngine };
