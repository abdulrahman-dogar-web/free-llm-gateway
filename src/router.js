// router.js — model routing + fallback / key rotation.
//
// Resolution order for a requested model:
//   1. routes[model]            — explicit ordered provider list from config
//                                 or the dashboard.
//   2. Providers that list the model, in defaultFallback order.
//   3. Every other enabled provider, in defaultFallback order (so a model
//      name a provider knows under a different name still gets a chance
//      via modelAliases).
// Providers in cooldown are skipped unless every candidate is cooling
// down, in which case the one whose cooldown expires soonest is tried.
// A 429 / quota / 5xx / network failure marks the provider down (cooldown)
// and the router immediately tries the next provider — that is the
// key-rotation / fallback behaviour. A 400 / 404 / 422 is a bad request:
// it is returned at once instead of burning through every provider.

import { appendUsage } from './store.js';
import { callProvider, isInCooldown, isUsable, markFailure, markSuccess, providerModelFor } from './providers.js';

export function resolveCandidates(store, model) {
  const providers = store.data.providers;
  const order = new Map();
  (store.data.defaultFallback || []).forEach((id, i) => order.set(id, i));
  const byId = new Map(providers.map((p) => [p.id, p]));
  const sortByFallback = (list) =>
    [...list].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));

  const usable = providers.filter(isUsable);
  let candidates = [];

  const explicit = store.data.routes?.[model];
  if (Array.isArray(explicit) && explicit.length) {
    candidates = explicit.map((id) => byId.get(id)).filter(Boolean).filter(isUsable);
  }
  if (!candidates.length) {
    candidates = sortByFallback(usable.filter((p) => (p.models || []).includes(model)));
  }
  if (!candidates.length) {
    candidates = sortByFallback(usable);
  }
  return candidates;
}

function pickAttemptOrder(candidates) {
  const fresh = candidates.filter((p) => !isInCooldown(p));
  if (fresh.length) return fresh;
  // All cooling down: try the one that recovers soonest, once.
  return [...candidates].sort(
    (a, b) => new Date(a.health?.cooldownUntil || 0) - new Date(b.health?.cooldownUntil || 0),
  ).slice(0, 1);
}

function usageOf(data) {
  const u = data?.usage || {};
  return {
    promptTokens: Number(u.prompt_tokens) || 0,
    completionTokens: Number(u.completion_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0,
  };
}

export async function routeChatCompletion(store, { model, body, keyId }) {
  const settings = store.data.settings;
  const cooldownSeconds = Number(settings.cooldownSeconds) || 60;
  const timeoutMs = Number(settings.requestTimeoutMs) || 60000;

  const candidates = resolveCandidates(store, model);
  if (!candidates.length) {
    const err = new Error(
      'No provider is configured for this model. Add a provider with an API key in the dashboard or config.json.',
    );
    err.statusCode = 503; err.code = 'no_provider'; err.attempted = [];
    throw err;
  }

  const attempted = [];
  let lastError = null;

  for (const provider of pickAttemptOrder(candidates)) {
    const providerModel = providerModelFor(provider, model);
    const requestBody = { ...body, model: providerModel };
    // Streaming is forwarded raw; usage is unknown until the stream ends.
    if (body.stream) {
      return { stream: true, provider, providerModel, requestBody, attempted };
    }
    attempted.push(provider.id);
    try {
      const { data, latencyMs } = await callProvider(provider, requestBody, { timeoutMs });
      markSuccess(store, provider);
      const usage = usageOf(data);
      appendUsage(store, {
        model, provider: provider.id, providerModel, keyId: keyId || null,
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        latencyMs, status: 'ok',
      });
      return { data, provider, providerModel, latencyMs, usage, attempted, stream: false };
    } catch (err) {
      lastError = err;
      appendUsage(store, {
        model, provider: provider.id, providerModel, keyId: keyId || null,
        promptTokens: 0, completionTokens: 0, latencyMs: err.latencyMs || 0,
        status: 'error', error: `${err.statusCode || 'network'}: ${err.message}`.slice(0, 300),
      });
      // Exhaustion / quota / rate limit -> cooldown + rotate to next.
      const cooldown = err.isQuota || err.statusCode === 429 ? cooldownSeconds : err.retryable ? 30 : 0;
      markFailure(store, provider, { statusCode: err.statusCode ?? null, error: err.message, cooldownSeconds: cooldown });
      if (!err.retryable) break; // 400/404/422 — the request itself is wrong.
    }
  }

  const err = new Error(
    lastError
      ? `All providers failed. Last error (${attempted.at(-1) || 'none'}): ${lastError.message}`
      : 'All providers failed.',
  );
  err.statusCode = lastError?.statusCode === 429 ? 429 : 502;
  err.code = 'all_providers_failed';
  err.attempted = attempted;
  err.lastError = lastError;
  throw err;
}

// Streaming attempt: pipes the provider's SSE stream straight through to
// the client while watching for a terminal usage chunk. Used only when
// the client asked for stream: true.
export async function streamFromProvider(store, provider, requestBody, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, Accept: 'text/event-stream' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text)?.error?.message || msg; } catch {}
      const err = new Error(msg || `HTTP ${res.status}`);
      err.statusCode = res.status;
      err.retryable = res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403;
      err.isQuota = res.status === 429 || /quota|rate limit/i.test(String(msg));
      throw err;
    }
    return { res, controller, timer };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') { const e = new Error('Provider stream timed out'); e.retryable = true; throw e; }
    throw err;
  }
}
