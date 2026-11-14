// desktop/main.js — Electron 主进程：窗口、托盘、IPC、代理生命周期
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const { loadConfig, createProxyServer } = require(path.join(APP_ROOT, 'server.js'));
const { getEngine, getCredentialState } = require(path.join(APP_ROOT, 'engine.js'));
const accountManager = require(path.join(APP_ROOT, 'account-manager.js'));
const { LoginManager } = require(path.join(APP_ROOT, 'login-manager.js'));

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ZCodeProxy';
const SETTINGS_FILE = path.join(APP_ROOT, 'settings.json');

let win = null;
let tray = null;
let quitting = false;
let proxy = null;
let config = null;
let loginManager = null;
let lastSendLogAt = 0;

// ---------- 设置 ----------

function loadSettings() {
  const defaults = { proxyEnabled: true, closeAction: 'tray', launchAtLogin: false };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return defaults;
  }
}
let settings = loadSettings();
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// ---------- 开机自启（注册表 Run 键） ----------

function getLaunchAtLogin() {
  try {
    const out = spawnSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { encoding: 'utf8', windowsHide: true });
    return out.status === 0 && (out.stdout || '').includes('ZCodeProxy');
  } catch {
    return false;
  }
}
function setLaunchAtLogin(on) {
  const exe = process.execPath;
  if (on) {
    spawnSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${exe}" --hidden`, '/f'], { windowsHide: true });
  } else {
    spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
  }
  settings.launchAtLogin = on;
  saveSettings();
}

// ---------- 托盘图标（运行中绿点 / 已停止灰点，程序化生成无需资源文件） ----------

function trayIcon(running) {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2 - 0.5, cy = size / 2 - 0.5, r = 5.2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const idx = (y * size + x) * 4;
      if (d <= r) {
        // BGRA：运行中 #30d158（Apple 绿），停止 #8e8e93（Apple 灰）
        const [b, g, r8] = running ? [0x58, 0xd1, 0x30] : [0x93, 0x8e, 0x8e];
        buf[idx] = b; buf[idx + 1] = g; buf[idx + 2] = r8; buf[idx + 3] = 255;
      } else {
        buf[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ---------- 通用 ----------

function sendToUI(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(' ')}`;
  console.log(line);
  const now = Date.now();
  if (now - lastSendLogAt > 150) { lastSendLogAt = now; sendToUI('log', line); }
}

async function applyProxyState(on) {
  if (on) {
    if (!proxy.isRunning()) await proxy.start();
  } else {
    if (proxy.isRunning()) await proxy.stop();
    // 只在引擎确实存活时释放，绝不因"关开关"而新建引擎
    try {
      const engineMod = require(path.join(APP_ROOT, 'engine.js'));
      if (engineMod.isEngineAlive()) await engineMod.disposeEngine();
    } catch { /* 引擎未起则忽略 */ }
  }
  settings.proxyEnabled = on;
  saveSettings();
  refreshTray();
  sendToUI('state', uiState());
}

function uiState() {
  const engineMod = require(path.join(APP_ROOT, 'engine.js'));
  return {
    proxyRunning: proxy.isRunning(),
    port: config.port,
    host: config.host,
    baseUrl: `http://${config.host}:${config.port}/v1`,
    engineAlive: proxy.isRunning() ? engineMod.isEngineAlive() : false,
    credential: getCredentialState(),
    accounts: accountManager.getAccounts(config, { getLastCallByFamily: () => proxy.getLastCallByFamily() }),
    models: config.models.map((m) => ({ id: m.id, providerId: m.providerId, modelId: m.modelId, reasoningLevel: m.reasoningLevel })),
    settings: { closeAction: settings.closeAction, launchAtLogin: getLaunchAtLogin() },
    login: loginManager.status(),
    zcodePathsMissing: Boolean(config.zcodePathsMissing),
  };
}

function refreshTray() {
  if (!tray) return;
  const running = proxy.isRunning();
  tray.setImage(trayIcon(running));
  tray.setToolTip(`ZCode 反向代理 · ${running ? '运行中' : '已停止'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? '停止代理' : '启动代理', click: () => { applyProxyState(!running).catch((e) => log(e.message)); } },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: getLaunchAtLogin(), click: (item) => setLaunchAtLogin(item.checked) },
    { type: 'separator' },
    { label: '打开面板', click: () => showWindow() },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  sendToUI('state', uiState());
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 920,
    height: 780,
    minWidth: 760,
    minHeight: 640,
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  // 关闭行为：托盘 or 退出（托盘菜单的退出会先置 quitting）
  win.on('close', (e) => {
    if (quitting || settings.closeAction !== 'tray') return;
    e.preventDefault();
    win.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('state', () => uiState());
  ipcMain.handle('toggle', async (_e, on) => {
    try {
      await applyProxyState(Boolean(on));
      return { running: proxy.isRunning() };
    } catch (err) {
      log(`[toggle] 切换失败: ${err.message}`);
      return { running: proxy.isRunning(), error: err.message };
    }
  });
  ipcMain.handle('account:add', async (_e, family) => {
    if (config.zcodePathsMissing) return { ok: false, error: '未找到 ZCode 桌面版，无法发起登录。' };
    let browserOpened = false;
    const r = loginManager.start(family, {
      zcodeExe: config.zcodeExe,
      zcodeCjs: config.zcodeCjs,
      openBrowser: async (u) => {
        try {
          await shell.openExternal(u);
          browserOpened = true;
        } catch (e) {
          log(`[login] 自动打开浏览器失败（请在界面复制授权网址手动打开）: ${e.message}`);
        }
      },
      log,
    });
    if (!r.ok) return { ok: false, error: r.error };
    // 等登录进程输出授权 URL（通常 <1s），让界面立刻拿到网址
    for (let i = 0; i < 10 && !loginManager.status().url; i += 1) {
      await new Promise((res) => setTimeout(res, 300));
    }
    const st = loginManager.status();
    return { ok: true, loginId: r.loginId, family, url: st.url || null, browserOpened };
  });
  ipcMain.handle('account:cancelLogin', () => { loginManager.cancel(); return { ok: true }; });
  ipcMain.handle('account:remove', (_e, family) => {
    const r = accountManager.removeAccount(family);
    sendToUI('state', uiState());
    return r;
  });
  ipcMain.handle('account:test', async (_e, family) => {
    const modelEntry = config.models.find((m) => String(m.providerId || '').includes(family));
    if (!modelEntry) return { ok: false, error: `没有 ${family} 体系的模型（config.models）` };
    try {
      const engine = await getEngine(config);
      const sessionId = await engine.createSession(modelEntry);
      let finalText = '';
      let turnError = null;
      let ended = false;
      let resolveTurn;
      const turnDone = new Promise((r) => { resolveTurn = r; });
      const finish = () => { if (!ended) { ended = true; off(); resolveTurn(); } };
      const off = engine.onEvent((n) => {
        if (n.method === 'session/event') {
          const p = n.params?.payload || {};
          if (p.kind === 'text_delta' && p.delta) finalText += p.delta;
          if (n.params?.type === 'turn.completed') finish();
          if (n.params?.type === 'turn.failed') { turnError = p.error?.message || 'failed'; finish(); }
        } else if (n.method === 'computer-use/operation-event') {
          if (n.params?.kind === 'turn-completed') finish();
          if (n.params?.kind === 'turn-failed') { turnError = turnError || n.params.lastError?.message || 'failed'; finish(); }
        }
      });
      try {
        await engine.subscribe(sessionId);
        await engine.send(sessionId, '只回复两个字：正常', modelEntry);
        const timeout = setTimeout(finish, 180000);
        await turnDone;
        clearTimeout(timeout);
      } catch (err) {
        off();
        engine.closeSession(sessionId).catch(() => {});
        accountManager.recordCall(family, false, err.message);
        sendToUI('state', uiState());
        return { ok: false, error: err.message };
      }
      engine.closeSession(sessionId).catch(() => {});
      if (turnError) {
        accountManager.recordCall(family, false, turnError);
        sendToUI('state', uiState());
        return { ok: false, error: turnError };
      }
      accountManager.recordCall(family, true);
      sendToUI('state', uiState());
      return { ok: true, reply: finalText.trim() };
    } catch (err) {
      accountManager.recordCall(family, false, err.message);
      sendToUI('state', uiState());
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('settings:set', (_e, patch) => {
    if (patch && typeof patch.closeAction === 'string') {
      settings.closeAction = patch.closeAction === 'quit' ? 'quit' : 'tray';
    }
    if (patch && typeof patch.launchAtLogin === 'boolean') {
      setLaunchAtLogin(patch.launchAtLogin);
    }
    saveSettings();
    refreshTray();
    return { settings: { closeAction: settings.closeAction, launchAtLogin: getLaunchAtLogin() } };
  });
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('open:url', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
}

// ---------- E2E 自检（--e2e：自动验证核心功能后退出） ----------

async function runE2E() {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`[e2e] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 1. 代理已随启动恢复
    await wait(2500);
    check('代理自启', proxy.isRunning(), `port=${config.port}`);

    // 2. health 探测
    const h = await fetch(`http://127.0.0.1:${config.port}/health`).then((r) => r.json()).catch((e) => null);
    check('health 探测', Boolean(h?.status === 'ok'), JSON.stringify(h));

    // 3. 挂起连接（模拟客户端 keep-alive）下关闭开关 → 必须及时完成且端口释放
    const net = require('node:net');
    const sock = net.connect(config.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r)); // 占住一个连接（不发请求）
    const t0 = Date.now();
    await applyProxyState(false);
    const stopTook = Date.now() - t0;
    sock.destroy();
    await wait(300);
    let portFree = true;
    try { await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1200) }); portFree = false; } catch { portFree = true; }
    check('挂起连接下关闭<5s且端口释放', portFree && !proxy.isRunning() && stopTook < 5000, `${stopTook}ms`);

    // 4. 重开 → 恢复
    await applyProxyState(true);
    await wait(600);
    const h2 = await fetch(`http://127.0.0.1:${config.port}/health`).then((r) => r.json()).catch(() => null);
    check('总开关重开→恢复', Boolean(h2?.status === 'ok'));

    // 5. 账号状态结构（两体系槽位）
    const st = uiState();
    check('账号槽位=2', st.accounts.length === 2, st.accounts.map((a) => `${a.family}:${a.status}`).join(' '));
    const zai = st.accounts.find((a) => a.family === 'zai');
    check('国际账号已添加', Boolean(zai?.added), `账号名=${zai?.accountName || '-'} 状态=${zai?.status}`);

    // 6. 真实调用检测（zai 体系）
    const modelEntry = config.models.find((m) => String(m.providerId).includes('zai'));
    const engine = await getEngine(config);
    const sessionId = await engine.createSession(modelEntry);
    let finalText = '';
    let turnError = null;
    let ended = false;
    let resolveT;
    const turnDone = new Promise((r) => { resolveT = r; });
    const finish = () => { if (!ended) { ended = true; off(); resolveT(); } };
    const off = engine.onEvent((n) => {
      if (n.method === 'session/event') {
        const p = n.params?.payload || {};
        if (p.kind === 'text_delta' && p.delta) finalText += p.delta;
        if (n.params?.type === 'turn.completed') finish();
        if (n.params?.type === 'turn.failed') { turnError = p.error?.message || 'failed'; finish(); }
      } else if (n.method === 'computer-use/operation-event') {
        if (n.params?.kind === 'turn-completed') finish();
        if (n.params?.kind === 'turn-failed') { turnError = n.params.lastError?.message || 'failed'; finish(); }
      }
    });
    await engine.subscribe(sessionId);
    await engine.send(sessionId, '只回复两个字：正常', modelEntry);
    const timeout = setTimeout(finish, 180000);
    await turnDone;
    clearTimeout(timeout);
    engine.closeSession(sessionId).catch(() => {});
    check('agent 真实调用', !turnError && finalText.trim().length > 0, turnError ? turnError : `回复=${finalText.trim()}`);

    // 7. 开机自启键开/关
    setLaunchAtLogin(true);
    const q1 = getLaunchAtLogin();
    setLaunchAtLogin(false);
    const q2 = getLaunchAtLogin();
    check('自启注册表键开/关', q1 === true && q2 === false);

    // 8. 设置持久化
    settings.closeAction = 'quit';
    saveSettings();
    const reloaded = loadSettings();
    check('设置持久化', reloaded.closeAction === 'quit');
    settings.closeAction = 'tray';
    saveSettings();
  } catch (err) {
    check('E2E 异常', false, err.message);
  }

  console.log('[e2e] RESULT ' + JSON.stringify(results));
  quitting = true;
  app.exit(results.every((r) => r.ok) ? 0 : 1);
}

// ---------- 生命周期 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    config = loadConfig({ dir: APP_ROOT, log });
    loginManager = new LoginManager();
    proxy = createProxyServer({ config, log });
    registerIpc();

    createWindow();
    tray = new Tray(trayIcon(false));
    refreshTray();

    // 恢复上次的代理开关状态
    applyProxyState(settings.proxyEnabled !== false).catch((err) => log(`代理启动失败: ${err.message}`));

    if (process.argv.includes('--e2e')) runE2E();

    app.on('before-quit', () => {
      quitting = true;
      try { proxy?.stop(); } catch { /* ignore */ }
      try {
        const engineMod = require(path.join(APP_ROOT, 'engine.js'));
        if (engineMod.disposeEngine) engineMod.disposeEngine();
      } catch { /* ignore */ }
    });
    app.on('window-all-closed', () => { if (quitting) app.quit(); });
  });
}
