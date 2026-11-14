// adapter.js — OpenAI 协议 <-> ZCode prompt/结果 的转换
'use strict';

const crypto = require('node:crypto');

function newCompletionId() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

/** 从 messages 中取最后一条用户消息文本 */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') return contentToText(m.content);
  }
  return null;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // OpenAI 多模态数组：取 text 部分
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/**
 * OpenAI messages[] -> 单个 prompt（无状态模式）。
 * - system 消息置于最前
 * - 多轮时渲染为对话历史文本块，末尾要求 ZCode 回应最后一条用户消息
 * - 仅一条用户消息（无 system）时原样透传
 */
function messagesToPrompt(messages) {
  const systems = [];
  const history = [];
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const text = contentToText(m.content);
    if ((m.role === 'system' || m.role === 'developer') && text.trim()) {
      systems.push(text.trim());
    } else if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') {
      if (text.trim()) history.push({ role: m.role, text, name: m.name || m.tool_call_id || '' });
    }
  }

  const lastUser = [...history].reverse().find((h) => h.role === 'user');
  const finalUserText = lastUser ? lastUser.text : '';

  if (systems.length === 0 && history.length <= 1) {
    return finalUserText;
  }

  const lines = [];
  if (systems.length) {
    lines.push('【系统指令】', systems.join('\n\n'), '');
  }
  if (history.length > 1) {
    lines.push('【对话历史（供参考）】');
    for (const h of history) {
      const label = h.role === 'user' ? '用户' : h.role === 'assistant' ? '助手' : `工具结果${h.name ? `(${h.name})` : ''}`;
      lines.push(`${label}: ${h.text}`);
    }
    lines.push('');
  }
  lines.push(
    '请以 ZCode agent 的身份直接回应上面的最后一条用户消息。',
    '不要复述历史内容；若任务需要执行操作（写代码、查文件等），请像往常一样使用工具完成。',
    '',
    '【最后一条用户消息】',
    finalUserText,
  );
  return lines.join('\n');
}

/**
 * 会话续接模式：只发新增的用户消息。
 * 客户端带着 X-Zcode-Session-Id 来时，ZCode 会话本身已有上下文，
 * 若客户端仍发了历史消息，只取最后一条用户消息。
 */
function messagesToResumePrompt(messages) {
  const last = lastUserText(messages);
  return last || messagesToPrompt(messages);
}

// ---------- OpenAI 响应构造 ----------

function openAiError(status, message, type = 'invalid_request_error', code) {
  return { status, body: { error: { message, type, ...(code ? { code } : {}) } } };
}

function chatCompletionResult({ id, model, content, usage, sessionId }) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    ...(usage ? { usage } : {}),
    ...(sessionId ? { zcode_session_id: sessionId } : {}),
  };
}

function chatCompletionChunk({ id, model, delta, finishReason = null, usage }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * 把 zcode result.usage（形状随版本变化）尽力映射为 OpenAI usage。
 * 无法识别时返回 undefined（OpenAI 允许省略）。
 */
function mapUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const num = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const input = num('inputTokens', 'promptTokens', 'input_tokens', 'prompt_tokens', 'totalInputTokens');
  const output = num('outputTokens', 'completionTokens', 'output_tokens', 'completion_tokens', 'totalOutputTokens');
  if (input == null && output == null) return undefined;
  const total = num('totalTokens', 'total_tokens') ?? (input ?? 0) + (output ?? 0);
  return { prompt_tokens: input ?? 0, completion_tokens: output ?? 0, total_tokens: total };
}

module.exports = {
  contentToText,
  messagesToPrompt,
  messagesToResumePrompt,
  lastUserText,
  newCompletionId,
  openAiError,
  chatCompletionResult,
  chatCompletionChunk,
  mapUsage,
};
