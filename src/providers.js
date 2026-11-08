// providers.js — provider registry, health tracking and the
// OpenAI-compatible adapter used for every provider.
//
// Every supported provider speaks the OpenAI chat-completions wire format
// (POST {baseUrl}/chat/completions, Bearer key, {model, messages, ...}).
// That is the whole point of the adapter: one code path serves Groq,
// OpenRouter, Together, Mistral, Gemini (via its OpenAI-compatible
// endpoint) and Cloudflare Workers AI, plus any future provider you add
// with a base URL + key + model list.

import { freshHealth, isRealKey } from './store.js';

export const PRESETS = [
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-flash-1.5'] },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'] },
  { id: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-7b', 'codestral-latest'] },
  { id: 'gemini', name: 'Google Gemini (OpenAI-compatible)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'] },
  { id: 'cloudflare', name: 'Cloudflare Workers AI', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1', models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/qwen/qwen2.5-coder-32b-instruct', '@cf/mistral/mistral-7b-instruct-v0.3'] },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', baseUrl: '', models: [] },
];

export function publicProvider(p) {
  const health = p.health || freshHealth();
  const now = Date.now();
  const inCooldown = health.cooldownUntil && new Date(health.cooldownUntil).getTime() > now;
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    models: p.models || [],
    modelAliases: p.modelAliases || {},
    enabled: p.enabled !== false,
    hasKey: isRealKey(p.apiKey),
    keyPreview: isRealKey(p.apiKey) ? `${p.apiKey.slice(0, 4)}…${p.apiKey.slice(-4)}` : null,
    createdAt: p.createdAt,
    health: {
      ...health,
      status: !p.enabled ? 'disabled' : inCooldown ? 'cooldown' : health.status,
      cooldownSecondsRemaining: inCooldown
        ? Math.ceil((new Date(health.cooldownUntil).getTime() - now) / 1000)
        : 0,
    },
  };
}

export function isUsable(p) {
  return p.enabled !== false && isRealKey(p.apiKey) && p.baseUrl;
}

export function isInCooldown(p, now = Date.now()) {
  const until = p.health?.cooldownUntil;
  return !!until && new Date(until).getTime() > now;
}

// Map the logical (gateway) model name to the model name this provider
// actually expects. Falls back to the logical name unchanged.
export function providerModelFor(provider, logicalModel) {
  if (provider.modelAliases && provider.modelAliases[logicalModel]) {
    return provider.modelAliases[logicalModel];
  }
  return logicalModel;
}

export function markSuccess(store, provider) {
  const h = (provider.health ??= freshHealth());
  h.status = 'up';
  h.lastSuccessAt = new Date().toISOString();
  h.consecutiveFailures = 0;
  h.totalRequests++;
  h.cooldownUntil = null;
  store.save();
}

export function markFailure(store, provider, { statusCode = null, error = null, cooldownSeconds = 0 } = {}) {
  const h = (provider.health ??= freshHealth());
  h.lastErrorAt = new Date().toISOString();
  h.lastError = String(error || `HTTP ${statusCode || 'error'}`).slice(0, 300);
  h.lastStatusCode = statusCode;
  h.consecutiveFailures++;
  h.totalRequests++;
  h.totalErrors++;
  if (cooldownSeconds > 0) {
    h.status = 'cooldown';
    h.cooldownUntil = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
  } else {
    h.status = 'down';
    h.cooldownUntil = null;
  }
  store.save();
}

// One attempt against one provider. Throws a typed error the router uses
// to decide whether to try the next provider.
export async function callProvider(provider, body, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || text.slice(0, 300) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.statusCode = res.status;
      err.latencyMs = latencyMs;
      err.retryable = res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403;
      err.isQuota = res.status === 429 || /quota|rate limit|rate_limit|insufficient|exhausted|credit/i.test(String(msg));
      throw err;
    }
    return { data, latencyMs };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Request to ${provider.name} timed out after ${timeoutMs}ms`);
      e.statusCode = null; e.latencyMs = Date.now() - started; e.retryable = true; e.isQuota = false;
      throw e;
    }
    if (err.retryable === undefined) {
      err.retryable = true; err.isQuota = false; err.latencyMs = Date.now() - started;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
