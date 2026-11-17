// account-manager.js — 两体系账号槽位管理（国际 Z.AI / 国内 BigModel）
//
// ZCode 凭据模型：每个账号体系只能有一个活动登录。本模块提供：
//   getAccounts(config)      → 两体系槽位状态（凭据存在性、账号名、最近调用结果）
//   removeAccount(family)    → 从共享凭据文件清理该体系键（其他键原样保留）
//   testAccount(family, ...) → 发一条极小请求验证该体系全链路，结果计入状态
//
// 状态判定：
//   missing  未添加（无该体系凭据）
//   ok       正常（凭据在 + 最近调用成功）
//   expired  凭据过期（最近调用报 401/JWT 类错误）→ UI 给「重新登录」按钮
//   error    异常（其他错误，显示具体原因）
//   unknown  已添加但从未检测

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getCredentialCache, resolveDataRoot, decryptAny, ensureCredentialCacheSync } = require('./engine');

// 桌面版热更新（2026-11）后凭据键有两代命名：
//   旧：oauth:zai:* / oauth:bigmodel:*
//   新：国内域 zai 登录写 oauth:zai_cn:*；ZAI 账号关联的 BigModel 凭据在 oauth:linked_bigmodel
// 引擎 providerId（account:zai-*）不变，只是凭据存储键名变了 —— 检测需两代都认。
const FAMILIES = {
  zai: {
    label: 'Z.AI 账号',
    oauthPrefixes: ['oauth:zai', 'oauth:zai_cn'],
    providerPrefix: 'account:zai-',
    loginFamily: 'zai',
  },
  bigmodel: {
    label: '国内 BigModel',
    oauthPrefixes: ['oauth:bigmodel'],
    linkedKey: 'oauth:linked_bigmodel',
    providerPrefix: 'account:bigmodel-',
    loginFamily: 'bigmodel',
  },
};

// 最近调用结果（进程内记录；由 proxy-controller 的 recordCall 写入 / testAccount 写入）
const lastCallStore = new Map();

function recordCall(family, ok, error) {
  if (!FAMILIES[family]) return;
  lastCallStore.set(family, { ok, error: ok ? null : String(error || '').slice(0, 300), at: Date.now() });
}

function credentialFile(env = process.env) {
  return path.join(resolveDataRoot(env), '.zcode', 'v2', 'credentials.json');
}

function readCredFile(env = process.env) {
  const file = credentialFile(env);
  try {
    return { file, cred: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { file, cred: null };
  }
}

function accountName(family) {
  const names = getCredentialCache().names || {};
  return names[family] || null;
}

function hasFamilyCredentials(cred, family) {
  const f = FAMILIES[family];
  if (!cred) return false;
  for (const prefix of f.oauthPrefixes) {
    const token = cred[`${prefix}:access_token`];
    if (typeof token === 'string' && token.trim()) return true;
  }
  if (f.linkedKey && typeof cred[f.linkedKey] === 'string' && cred[f.linkedKey].trim()) return true;
  return Object.keys(cred).some((k) => k.startsWith('account-provider:account:' + f.providerPrefix.slice('account:'.length)) && String(cred[k] || '').trim());
}

function classifyError(text) {
  const t = String(text || '');
  if (/401|unauthorized|jwt|token.*(expire|invalid)|project_token|凭据|登录/i.test(t)) return 'expired';
  if (/1113|余额|balance|资源包/i.test(t)) return 'error';
  if (/abort|timeout|超时/i.test(t)) return 'error';
  return t ? 'error' : null;
}

/**
 * 两体系槽位状态。
 * @param {object} config 代理配置（用于匹配 model → family）
 * @param {object} deps { getLastCallByFamily():Record } 由 proxy-controller 提供
 */
function getAccounts(config, { getLastCallByFamily = () => ({}), zcodeExe } = {}) {
  // 桌面版可能刚完成登录：先同步刷新凭据缓存（账号名/JWT 从新文件解密；mtime 未变时零开销）
  try { ensureCredentialCacheSync(zcodeExe || config?.zcodeExe); } catch { /* best-effort，沿用缓存 */ }
  const { file, cred } = readCredFile();
  const lastCalls = getLastCallByFamily() || {};
  // in-memory 优先，其次模块内 store
  return Object.entries(FAMILIES).map(([family, meta]) => {
    let added = false;
    let accountNameValue = null;
    try {
      added = hasFamilyCredentials(cred, family);
      accountNameValue = added ? accountName(family) : null;
    } catch { /* 单体系状态失败不影响整体 */ }
    const call = lastCalls[family] || lastCallStore.get(family) || null;
    let status = 'missing';
    let lastError = null;
    if (added) {
      if (call) {
        if (call.ok) status = 'ok';
        else {
          lastError = call.error;
          status = classifyError(call.error) || 'error';
        }
      } else {
        status = 'unknown';
      }
    }
    return {
      family,
      label: meta.label,
      added,
      accountName: accountNameValue,
      status,
      lastError,
      lastCallAt: call?.at || null,
      credentialFile: file,
      models: config.models
        .filter((m) => String(m.providerId || '').includes(family === 'zai' ? 'zai' : 'bigmodel'))
        .map((m) => m.id),
    };
  });
}

/**
 * 删除账号：从共享凭据文件清理该体系全部键（覆盖两代键名）。
 * - oauth:<family>:* 与 oauth:zai_cn:*（热更新后国内域 zai 登录的存储键）
 * - oauth:linked_bigmodel（ZAI 账号关联的 BigModel 凭据，删 bigmodel 时清理）
 * - account-provider:*:identity / auth-source / api-key（含该体系标识的）
 * - oauth:active_provider 仅当其值属于该体系时删除（zai 体系可能为 'zai' 或 'zai_cn'）
 * 不动 zcodejwttoken（两体系共享）与 project-key-location（过期无害）。
 */
async function removeAccount(family, env = process.env) {
  const meta = FAMILIES[family];
  if (!meta) return { ok: false, error: `未知账号体系: ${family}` };
  const { file, cred } = readCredFile(env);
  if (!cred) return { ok: false, error: '凭据文件不存在或不可读' };

  const removed = [];
  const next = { ...cred };
  for (const key of Object.keys(next)) {
    if (meta.oauthPrefixes.some((p) => key.startsWith(p + ':'))) { delete next[key]; removed.push(key); continue; }
    if (meta.linkedKey && key === meta.linkedKey) { delete next[key]; removed.push(key); continue; }
    if (key.startsWith('account-provider:') && key.includes(':' + meta.providerPrefix)) { delete next[key]; removed.push(key); continue; }
  }
  if (typeof next['oauth:active_provider'] === 'string') {
    try {
      const active = await decryptAny(next['oauth:active_provider'], file, undefined, env);
      const ownsActive = active === meta.loginFamily
        || (family === 'zai' && active === 'zai_cn'); // 国内域下 zai 登录的 active 值为 zai_cn
      if (ownsActive) { delete next['oauth:active_provider']; removed.push('oauth:active_provider'); }
    } catch { /* ignore */ }
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  lastCallStore.delete(family);
  return { ok: true, removed, file };
}

module.exports = { getAccounts, removeAccount, recordCall, hasFamilyCredentials, FAMILIES, credentialFile };
