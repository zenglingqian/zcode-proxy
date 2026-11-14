#!/usr/bin/env node
// server.js — ZCode 反向代理（OpenAI 兼容 API 网关）
//
// 双形态：
//   1. CLI 独立运行：  node server.js（启动后常驻，Ctrl+C 退出）
//   2. 被 Electron 主进程 require：const { createProxyServer, loadConfig } = require('./server')
//      → { start(), stop(), isRunning() } 可启停（桌面应用的总开关）
//
// 路由：
//   POST /v1/chat/completions  →  ZCode 引擎会话（agent 完整能力）
//   GET  /v1/models  GET /health  GET /（网页管理台，CLI 回退用）
//
// 会话续接：请求头 X-Zcode-Session-Id: sess_... → 引擎 session/resume。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const { getEngine, isEngineAlive, getCredentialState, resolveZcodePaths, dataBaseDir } = require('./engine');
const { LoginManager, openInBrowser } = require('./login-manager');
const { adminPageHtml } = require('./admin-ui');
const {
  messagesToPrompt,
  messagesToResumePrompt,
  contentToText,
  newCompletionId,
  openAiError,
  chatCompletionResult,
  chatCompletionChunk,
  mapUsage,
} = require('./adapter');

// ---------- 配置 ----------

const DEFAULT_CONFIG = {
  port: 8787,
  host: '127.0.0.1',
  apiKey: '', // 留空 = 不鉴权；设置后要求 Authorization: Bearer <apiKey>
  zcodeExe: '', // 留空 = 自动探测 ZCode 安装路径
  zcodeCjs: '', // 留空 = 自动探测
  runtimeDir: '', // 留空 = <server.js 所在目录>/runtime
  maxConcurrent: 4,
  timeoutMs: 30 * 60 * 1000,
  includeReasoning: false,
  cors: true,
  models: [
    { id: 'zcode', providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'max', cwd: '', mode: 'yolo', disallowedTools: [] },
    { id: 'zcode-bigmodel', providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'max', cwd: '', mode: 'yolo', disallowedTools: [] },
  ],
};

function loadConfig({ dir = __dirname, log = console.log } = {}) {
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    log(`未找到 config.json，已按默认模板生成：${file}`);
  }
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { ...DEFAULT_CONFIG, ...user };
  // 环境变量覆盖端口（多实例/测试用）
  if (process.env.ZCODE_PROXY_PORT) cfg.port = Number(process.env.ZCODE_PROXY_PORT) || cfg.port;
  cfg.proxyDir = dir;
  cfg.runtimeDir = path.resolve(dir, cfg.runtimeDir || 'runtime');
  cfg.tasksRoot = cfg.tasksRoot && String(cfg.tasksRoot).trim()
    ? path.resolve(dir, cfg.tasksRoot)
    : path.join(os.homedir(), 'Documents', 'ZCodeProxy-Tasks');
  fs.mkdirSync(cfg.runtimeDir, { recursive: true });
  const byId = new Map(cfg.models.map((m) => [m.id, m]));
  if (byId.size !== cfg.models.length) throw new Error('config.models 中存在重复的 id');
  // ZCode 路径：留空 = 自动探测
  if (!String(cfg.zcodeExe || '').trim() || !String(cfg.zcodeCjs || '').trim()) {
    const found = resolveZcodePaths(process.env);
    if (found) {
      cfg.zcodeExe = found.zcodeExe;
      cfg.zcodeCjs = found.zcodeCjs;
      log(`已自动探测到 ZCode: ${found.source}`);
    } else {
      cfg.zcodePathsMissing = true;
      log('[!] 未找到 ZCode 桌面版安装（config 也未指定路径）。请确认已安装，或在 config.json 填写 zcodeExe/zcodeCjs。');
    }
  }
  return cfg;
}

// ---------- 工厂 ----------

/**
 * 创建可启停的代理服务实例。
 * @returns {{ httpServer, start():Promise, stop():Promise, isRunning():boolean }}
 */
function createProxyServer({ config, log = console.log }) {
  config.log = log;
  const modelById = new Map(config.models.map((m) => [m.id, m]));
  const loginManager = new LoginManager();
  const semaphore = { free: config.maxConcurrent, queue: [] };
  const lastCallByFamily = new Map(); // family -> {ok, error, at}（供账号状态展示）
  let httpServer = null;

  function acquireSlot(signal) {
    if (semaphore.free > 0) {
      semaphore.free -= 1;
      return { release() { const next = semaphore.queue.shift(); if (next) next.resolve(); else semaphore.free += 1; } };
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve({ release() { const next = semaphore.queue.shift(); if (next) next.resolve(); else semaphore.free += 1; } });
        },
      };
      const onAbort = () => {
        const i = semaphore.queue.indexOf(entry);
        if (i >= 0) semaphore.queue.splice(i, 1);
        reject(Object.assign(new Error('服务器繁忙，排队等待被中止'), { code: 'QUEUE_ABORTED' }));
      };
      semaphore.queue.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function applyCors(req, res) {
    if (!config.cors) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Zcode-Session-Id, X-Api-Key');
    res.setHeader('Access-Control-Expose-Headers', 'X-Zcode-Session-Id');
  }

  function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(data);
  }

  function readBody(req, limit = 20 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function checkAuth(req) {
    if (!config.apiKey) return true;
    const h = req.headers.authorization || '';
    const key = req.headers['x-api-key'] || '';
    return h === `Bearer ${config.apiKey}` || key === config.apiKey;
  }

  function pickModel(reqModel) {
    if (!reqModel) return config.models[0];
    return modelById.get(reqModel) || null;
  }

  function familyOf(modelEntry) {
    const pid = String(modelEntry.providerId || '');
    if (pid.includes('zai')) return 'zai';
    if (pid.includes('bigmodel')) return 'bigmodel';
    return null;
  }

  function recordCall(family, ok, error) {
    if (!family) return;
    lastCallByFamily.set(family, { ok, error: ok ? null : String(error || '').slice(0, 300), at: Date.now() });
  }

  // ---------- 会话亲和（自动续接同一 ZCode 会话） ----------
  // 第三方客户端每轮发完整 messages：若"去掉最后一条 user 消息后的历史"与某会话上轮
  // 记录匹配 → 自动 resume 该会话只发新消息（同一任务在 ZCode 中保持为一个连续会话）。
  const affinity = new Map(); // historyKey -> sess_id（LRU，上限 300）

  function serializeMessages(messages) {
    return JSON.stringify((messages || []).map((m) => ({ role: m && m.role, text: contentToText(m && m.content) })));
  }
  function affinityLookup(messages) {
    if (!Array.isArray(messages) || messages.length < 2) return null;
    const sess = affinity.get(serializeMessages(messages.slice(0, -1))) || null;
    if (sess) log(`[affinity] 命中续接会话 ${sess}`);
    return sess;
  }
  function affinityRemember(messages, sessionId, reply) {
    if (!sessionId) return;
    try {
      const key = serializeMessages([...(messages || []), { role: 'assistant', content: reply || '' }]);
      if (affinity.has(key)) affinity.delete(key);
      affinity.set(key, sessionId);
      while (affinity.size > 300) affinity.delete(affinity.keys().next().value);
    } catch { /* ignore */ }
  }

  // ---------- 同会话并发串行化 ----------

  const sessionLocks = new Map(); // sessionId -> 前一个持有者的完成信号
  function acquireSessionLock(sessionId) {
    const prev = sessionLocks.get(sessionId) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    sessionLocks.set(sessionId, prev.then(() => gate));
    return prev.then(() => release);
  }

  // ---------- 每任务独立工作区 ----------

  function makeTaskWorkspace(label) {
    const slug = String(label || '')
      .replace(/[\\/:*?"<>|\r\n]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24) || '任务';
    const stamp = new Date().toISOString().slice(5, 19).replace(/[T:]/g, '-');
    const dir = path.join(config.tasksRoot, `${slug}-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---------- 会话回合执行 ----------

  async function runTurn(opts, handlers = {}) {
    const { prompt, modelEntry, signal } = opts;
    let { resumeSession } = opts;
    const engine = await getEngine(config);

    // 每任务独立工作区：agent 在自己的沙盒目录工作，不依附任何既有项目
    let workspaceDir;
    if (!resumeSession && !modelEntry.cwd) {
      workspaceDir = makeTaskWorkspace(opts.taskLabel);
    }

    let sessionId;
    if (resumeSession) {
      try {
        sessionId = await engine.resumeSession(resumeSession);
      } catch (err) {
        // 会话不可续接（被删/损坏）→ 降级为新会话
        log(`[turn] 续接 ${resumeSession} 失败，降级新建会话: ${err.message}`);
        resumeSession = null;
        sessionId = await engine.createSession(modelEntry, workspaceDir);
      }
    } else {
      sessionId = await engine.createSession(modelEntry, workspaceDir);
    }
    handlers.onSessionId?.(sessionId);
    log(`[turn] 会话=${sessionId}${resumeSession ? ' (续接)' : ' (新建)'}`);

    // 同会话并发请求串行化（第二个请求等第一个回合结束后再发送）
    const releaseLock = await acquireSessionLock(sessionId);

    let finalText = '';
    let lastUsage = null;
    let turnError = null;
    let ended = false;

    let resolveTurn;
    const turnDone = new Promise((r) => { resolveTurn = r; });

    const finishTurn = () => {
      if (ended) return;
      ended = true;
      offEvent();
      resolveTurn();
    };

    const onEvent = (notification) => {
      const { method, params } = notification;
      // 【关键】严格按 sessionId 过滤：并发会话的事件互不可见（否则回答串扰）
      if (!params || params.sessionId !== sessionId) return;
      if (method === 'session/event') {
        const p = params?.payload || {};
        if (p.kind === 'text_delta' && typeof p.delta === 'string' && p.delta) {
          finalText += p.delta;
          handlers.onTextDelta?.(p.delta);
        } else if (p.kind === 'reasoning_delta' && typeof p.delta === 'string' && p.delta) {
          handlers.onReasoningDelta?.(p.delta);
        } else if (p.kind === 'tool_call' || p.kind === 'tool_input_start') {
          handlers.onActivity?.({ toolName: p.toolName, kind: p.kind });
        } else if (typeof p.content === 'string' && p.stopReason) {
          if (p.usage) lastUsage = p.usage;
          if (p.stopReason !== 'tool_use' && p.content.trim()) finalText = finalText.trim() ? finalText : p.content;
        }
        if (params?.type === 'turn.completed') return finishTurn();
        if (params?.type === 'turn.failed') {
          turnError = p.error?.message || p.error?.detail || 'turn failed';
          return finishTurn();
        }
        return;
      }
      if (method === 'computer-use/operation-event') {
        if (params?.kind === 'turn-completed') return finishTurn();
        if (params?.kind === 'turn-failed') {
          turnError = turnError || params.lastError?.message || 'turn failed';
          return finishTurn();
        }
      }
    };
    const offEvent = engine.onEvent(onEvent);

    const abortAndStop = () => {
      log('[turn] 收到中止信号，停止回合');
      engine.stopTurn(sessionId);
    };
    if (signal?.aborted) abortAndStop();
    else signal?.addEventListener('abort', abortAndStop, { once: true });

    try {
      await engine.subscribe(sessionId);
      await engine.send(sessionId, prompt, modelEntry);
      await turnDone;
    } catch (err) {
      offEvent();
      releaseLock();
      engine.closeSession(sessionId).catch(() => {});
      throw err;
    }
    releaseLock();

    if (signal?.aborted) {
      engine.closeSession(sessionId).catch(() => {});
      throw Object.assign(new Error('请求已中止（客户端断开或超时）'), { code: 'ABORTED' });
    }
    if (turnError) {
      engine.closeSession(sessionId).catch(() => {});
      throw new Error(`ZCode 回合失败: ${turnError}`);
    }

    engine.closeSession(sessionId).catch(() => {});
    return { sessionId, response: finalText.trim(), usage: lastUsage };
  }

  // ---------- 业务处理 ----------

  async function handleChatCompletions(req, res) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      const e = openAiError(400, `请求体不是合法 JSON: ${err.message}`);
      return sendJson(res, e.status, e.body);
    }

    const modelEntry = pickModel(body.model);
    if (!modelEntry) {
      const e = openAiError(404, `未知模型 "${body.model}"。可用模型: ${config.models.map((m) => m.id).join(', ')}`, 'invalid_request_error', 'model_not_found');
      return sendJson(res, e.status, e.body);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      const e = openAiError(400, 'messages 不能为空');
      return sendJson(res, e.status, e.body);
    }

    const headerSession = (req.headers['x-zcode-session-id'] || '').trim() || null;
    const resumeSession = headerSession || affinityLookup(body.messages);
    const prompt = resumeSession ? messagesToResumePrompt(body.messages) : messagesToPrompt(body.messages);
    const stream = Boolean(body.stream);
    const completionId = newCompletionId();
    const startedAt = Date.now();

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(new Error('timeout')), config.timeoutMs);
    const onClientClose = () => ac.abort(new Error('client closed'));
    req.on('close', onClientClose);

    let slot;
    let headersSent = false;
    try {
      slot = await acquireSlot(ac.signal);
    } catch (err) {
      clearTimeout(timeout); req.off('close', onClientClose);
      const e = openAiError(429, err.message, 'rate_limit_error', err.code);
      return sendJson(res, e.status, e.body);
    }

    log(`-> ${modelEntry.id}${resumeSession ? ` (resume ${resumeSession})` : ''} stream=${stream} prompt=${prompt.length}ch`);

    const runOpts = { prompt, modelEntry, resumeSession, taskLabel: require('./adapter').lastUserText(body.messages), signal: ac.signal, log };

    try {
      if (!stream) {
        const r = await runTurn(runOpts, {});
      affinityRemember(body.messages, r.sessionId, r.response);
        recordCall(familyOf(modelEntry), true);
        const usage = mapUsage(r.usage);
        const payload = chatCompletionResult({ id: completionId, model: modelEntry.id, content: r.response, usage, sessionId: r.sessionId });
        if (r.sessionId) res.setHeader('X-Zcode-Session-Id', r.sessionId);
        log(`<- ${modelEntry.id} 完成 ${Date.now() - startedAt}ms 会话=${r.sessionId} 回复=${(r.response || '').length}ch`);
        return sendJson(res, 200, payload);
      }

      // ---- 流式 SSE ----
      let sessionId = null;
      const ensureSseHeaders = () => {
        if (headersSent) return;
        headersSent = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...(sessionId ? { 'X-Zcode-Session-Id': sessionId } : {}),
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
      };
      const writeEvent = (obj) => { res.write(`data: ${JSON.stringify(obj)}\n\n`); };
      const writeComment = (text) => { res.write(`: ${text.replace(/[\r\n]/g, ' ')}\n\n`); };
      const sendRoleChunk = () => {
        writeEvent(chatCompletionChunk({ id: completionId, model: modelEntry.id, delta: { role: 'assistant', content: '' } }));
      };

      const wantUsage = Boolean(body.stream_options?.include_usage);

      const result = await runTurn(runOpts, {
        onSessionId(id) {
          sessionId = id;
          if (!headersSent) { ensureSseHeaders(); sendRoleChunk(); }
        },
        onTextDelta(text) {
          if (!headersSent) { ensureSseHeaders(); sendRoleChunk(); }
          writeEvent(chatCompletionChunk({ id: completionId, model: modelEntry.id, delta: { content: text } }));
        },
        onReasoningDelta(text) {
          if (!config.includeReasoning) return;
          if (!headersSent) { ensureSseHeaders(); sendRoleChunk(); }
          writeEvent(chatCompletionChunk({ id: completionId, model: modelEntry.id, delta: { reasoning_content: text } }));
        },
        onActivity(ev) {
          writeComment(`activity: ${ev.toolName || ev.kind}`);
        },
      });

      recordCall(familyOf(modelEntry), true);
      affinityRemember(body.messages, result.sessionId, result.response);
      ensureSseHeaders();
      const usage = mapUsage(result.usage);
      writeEvent(chatCompletionChunk({ id: completionId, model: modelEntry.id, delta: {}, finish_reason: 'stop', ...(wantUsage && usage ? { usage } : {}) }));
      writeEvent({ id: completionId, zcode_session_id: result.sessionId });
      res.write('data: [DONE]\n\n');
      res.end();
      log(`<- ${modelEntry.id} 完成(流式) ${Date.now() - startedAt}ms 会话=${result.sessionId}`);
    } catch (err) {
      recordCall(familyOf(modelEntry), false, err.message);
      const aborted = err.code === 'ABORTED';
      const msg = aborted ? '请求已中止（超时或客户端断开）' : err.message;
      log(`<- ${modelEntry.id} 失败 ${Date.now() - startedAt}ms: ${msg}`);
      if (!headersSent) {
        const status = aborted ? 504 : 502;
        const e = openAiError(status, `ZCode 调用失败: ${msg}`, 'upstream_error', err.code);
        sendJson(res, e.status, e.body);
      } else {
        try {
          writeEvent(chatCompletionChunk({ id: completionId, model: modelEntry.id, delta: {}, finish_reason: 'stop' }));
          res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch { /* 连接已断 */ }
      }
    } finally {
      clearTimeout(timeout);
      req.off('close', onClientClose);
      slot?.release();
    }
  }

  function handleModels(res) {
    const now = Math.floor(Date.now() / 1000);
    sendJson(res, 200, {
      object: 'list',
      data: config.models.map((m) => ({ id: m.id, object: 'model', created: now, owned_by: 'zcode-proxy' })),
    });
  }

  // 管理台的写操作保护：设了 apiKey 时，非本机来源需要鉴权
  function adminWriteAllowed(req) {
    if (!config.apiKey) return true;
    const addr = req.socket.remoteAddress || '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    return loopback || checkAuth(req);
  }

  function handleAdminStatus(res) {
    return sendJson(res, 200, {
      port: config.port,
      host: config.host,
      engineAlive: isEngineAlive(),
      credential: getCredentialState(),
      zcodePaths: config.zcodePathsMissing ? null : { zcodeExe: config.zcodeExe },
      dataDir: path.join(dataBaseDir(), '.zcode', 'v2'),
      models: config.models.map((m) => ({ id: m.id, providerId: m.providerId, modelId: m.modelId, reasoningLevel: m.reasoningLevel })),
      login: loginManager.status(),
    });
  }

  async function handleAdminTest(res) {
    try {
      const modelEntry = config.models[0];
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 180000);
      const r = await runTurn({ prompt: '只回复两个字：正常', modelEntry, signal: ac.signal, log }, {});
      clearTimeout(t);
      return sendJson(res, 200, { ok: true, reply: r.response, usage: mapUsage(r.usage) || null, sessionId: r.sessionId });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  // ---------- 服务器 ----------

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      // 任何未捕获异常都返回 500，绝不挂起连接
      try { sendJson(res, 500, { error: { message: `服务器内部错误: ${err.message}` } }); } catch { /* ignore */ }
      log(`[!] 请求处理异常: ${err.message}`);
    }
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (route === 'GET /' || route === 'GET /admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(adminPageHtml());
    }
    if (route === 'GET /admin/status') return handleAdminStatus(res);
    if (route === 'POST /admin/login') {
      if (!adminWriteAllowed(req)) return sendJson(res, 401, { error: { message: '未授权' } });
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
      if (config.zcodePathsMissing) return sendJson(res, 200, { ok: false, error: '未找到 ZCode 桌面版，无法发起登录。' });
      const r = loginManager.start(body.family, { zcodeExe: config.zcodeExe, zcodeCjs: config.zcodeCjs, runtimeDir: config.runtimeDir, openBrowser: openInBrowser, log });
      return sendJson(res, 200, r.ok ? { ...r, url: loginManager.status().url || null } : { ok: false, error: r.error });
    }
    if (route === 'GET /admin/login/status') return sendJson(res, 200, loginManager.status());
    if (route === 'POST /admin/login/cancel') {
      if (!adminWriteAllowed(req)) return sendJson(res, 401, { error: { message: '未授权' } });
      loginManager.cancel();
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /admin/test') {
      if (!adminWriteAllowed(req)) return sendJson(res, 401, { error: { message: '未授权' } });
      return handleAdminTest(res);
    }

    if (route === 'GET /health') {
      return sendJson(res, 200, { status: 'ok', models: config.models.map((m) => m.id) });
    }

    if (!checkAuth(req)) {
      return sendJson(res, 401, { error: { message: '未授权：缺少或错误的 API Key', type: 'authentication_error' } });
    }

    if (route === 'GET /v1/models') return handleModels(res);
    if (route === 'POST /v1/chat/completions') return handleChatCompletions(req, res);

  return sendJson(res, 404, { error: { message: `未知路由 ${route}`, type: 'invalid_request_error' } });
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`[!] 端口 ${config.port} 已被占用 —— 反代很可能已经在运行了。`);
      log(`    打开 http://127.0.0.1:${config.port}/ 确认；如需换端口请修改 config.json 的 port。`);
      throw err;
    }
    log(`[!] 服务器错误: ${err.message}`);
  });

  return {
    httpServer: server,
    isRunning() { return httpServer !== null; },
    loginStatus() { return loginManager.status(); },
    getLastCallByFamily() { return Object.fromEntries(lastCallByFamily); },
    async start() {
      if (httpServer) return;
      await new Promise((resolve, reject) => {
        const onError = (err) => { httpServer = null; reject(err); };
        server.once('error', onError);
        server.listen(config.port, config.host, () => {
          server.off('error', onError);
          httpServer = server;
          log(`ZCode 反向代理已启动: http://${config.host}:${config.port}`);
          log(`模型: ${config.models.map((m) => m.id).join(', ')} · 鉴权: ${config.apiKey ? '已启用' : '未启用'}`);
          resolve();
        });
      });
      // 预热引擎（失败不阻塞，首次请求会重试）
      getEngine(config).then(() => log('[engine] 引擎已就绪（账号快照已推送）')).catch((err) => log(`[engine] 引擎启动失败: ${err.message}`));
    },
    async stop() {
      if (!httpServer) return;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        httpServer.close(() => finish());
        // 强制断开 keep-alive 空闲连接，否则 close 会一直等连接结束（开关"没反应"的根因）
        try { httpServer.closeAllConnections(); } catch { /* 旧版 Node 无此 API */ }
        setTimeout(finish, 3000).unref?.();
      });
      httpServer = null;
      log('ZCode 反向代理已停止');
    },
  };
}

// ---------- CLI 入口 ----------

if (require.main === module) {
  const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
  const config = loadConfig({ log });
  const proxy = createProxyServer({ config, log });
  proxy.start().catch((err) => {
    if (err.code === 'EADDRINUSE') process.exit(1);
    log(`启动失败: ${err.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => {
    log('收到 SIGINT，退出');
    process.exit(0);
  });
}

module.exports = { createProxyServer, loadConfig, DEFAULT_CONFIG };
