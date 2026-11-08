// app.js — HTTP server for Free LLM Gateway. No framework, Node built-ins only.
// Serves the dashboard (public/), the OpenAI-compatible API (/v1/*) and the
// local dashboard API (/api/*). The dashboard API has no login by design:
// the server binds to 127.0.0.1 by default, so it is only reachable on this
// machine. Do not bind it to 0.0.0.0 on a shared network.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, appendUsage, computeStats, createKeyRecord, isRealKey, maskKey, readUsage, sha256 } from './store.js';
import { PRESETS, isInCooldown, isUsable, markFailure, markSuccess, publicProvider } from './providers.js';
import { resolveCandidates, routeChatCompletion, streamFromProvider } from './router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---- tiny .env loader (no dependency) -----------------------------------
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env — fine */ }
}
loadEnv();

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const CONFIG_PATH = path.resolve(process.env.CONFIG_PATH || path.join(ROOT, 'config.json'));
const store = new Store(DATA_DIR, CONFIG_PATH);
// Env overrides config file for host/port.
if (process.env.PORT) store.data.settings.port = Number(process.env.PORT);
if (process.env.HOST) store.data.settings.host = process.env.HOST;
if (process.env.COOLDOWN_SECONDS) store.data.settings.cooldownSeconds = Number(process.env.COOLDOWN_SECONDS);
if (process.env.REQUEST_TIMEOUT_MS) store.data.settings.requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS);

const PORT = Number(store.data.settings.port) || 8787;
const HOST = store.data.settings.host || '127.0.0.1';

// ---- helpers -------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function sendOpenAIError(res, status, message, code = 'gateway_error') {
  sendJson(res, status, { error: { message: String(message).slice(0, 500), type: 'gateway_error', code } });
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Request body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function bearerKey(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function authenticate(req) {
  const key = bearerKey(req);
  if (!key) return { ok: false, status: 401, message: 'Missing Authorization: Bearer <unified-key> header. Generate a unified key in the dashboard.' };
  const record = store.data.keys.find((k) => k.hash === sha256(key) && !k.revoked);
  if (!record) return { ok: false, status: 401, message: 'Invalid or revoked unified API key.' };
  record.lastUsedAt = new Date().toISOString();
  record.useCount = (record.useCount || 0) + 1;
  store.save();
  return { ok: true, key: record };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
}

function serveStatic(req, res, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

// ---- OpenAI-compatible API ----------------------------------------------
async function handleChatCompletions(req, res) {
  const auth = authenticate(req);
  if (!auth.ok) return sendOpenAIError(res, auth.status, auth.message, 'invalid_api_key');
  let body;
  try { body = await readBody(req); } catch (e) { return sendOpenAIError(res, 400, e.message, 'invalid_request'); }
  if (!body || typeof body !== 'object') return sendOpenAIError(res, 400, 'Request body must be a JSON object.', 'invalid_request');
  if (!body.model || typeof body.model !== 'string') return sendOpenAIError(res, 400, 'Missing required field: model.', 'invalid_request');
  if (!Array.isArray(body.messages) || body.messages.length === 0) return sendOpenAIError(res, 400, 'Missing required field: messages (non-empty array).', 'invalid_request');

  // Strip gateway-only fields so providers never see them.
  const { _gateway, ...providerBody } = body;

  try {
    const result = await routeChatCompletion(store, { model: body.model, body: providerBody, keyId: auth.key.id });
    res.setHeader('X-Gateway-Provider', result.provider.id);
    res.setHeader('X-Gateway-Model', body.model);
    res.setHeader('X-Gateway-Provider-Model', result.providerModel);
    res.setHeader('X-Gateway-Attempts', result.attempted.join(','));

    if (result.stream) {
      // Streaming: try providers in order until one streams successfully.
      const settings = store.data.settings;
      const timeoutMs = Number(settings.requestTimeoutMs) || 60000;
      const cooldownSeconds = Number(settings.cooldownSeconds) || 60;
      const candidates = resolveCandidates(store, body.model).filter((p) => !isInCooldown(p));
      const list = candidates.length ? candidates : resolveCandidates(store, body.model).slice(0, 1);
      let lastErr = null;
      for (const provider of list) {
        const providerModel = providerModelForSafe(provider, body.model);
        try {
          const { res: upstream, controller, timer } = await streamFromProvider(store, provider, { ...providerBody, model: providerModel }, { timeoutMs });
          markSuccess(store, provider);
          appendUsage(store, { model: body.model, provider: provider.id, providerModel, keyId: auth.key.id, promptTokens: 0, completionTokens: 0, latencyMs: 0, status: 'ok', streamed: true });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Gateway-Provider': provider.id, 'X-Gateway-Model': body.model });
          upstream.body.pipeTo(new WritableStream({ write: (c) => res.write(c), close: () => { clearTimeout(timer); controller.abort(); res.end(); } }))
            .catch(() => { clearTimeout(timer); if (!res.writableEnded) res.end(); });
          return;
        } catch (e) {
          lastErr = e;
          appendUsage(store, { model: body.model, provider: provider.id, providerModel, keyId: auth.key.id, promptTokens: 0, completionTokens: 0, latencyMs: 0, status: 'error', error: `${e.statusCode || 'network'}: ${e.message}`.slice(0, 300) });
          markFailure(store, provider, { statusCode: e.statusCode ?? null, error: e.message, cooldownSeconds: e.isQuota || e.statusCode === 429 ? cooldownSeconds : e.retryable ? 30 : 0 });
          if (!e.retryable) break;
        }
      }
      return sendOpenAIError(res, lastErr?.statusCode === 429 ? 429 : 502, lastErr?.message || 'All providers failed to stream.', 'all_providers_failed');
    }

    return sendJson(res, 200, result.data, {
      'X-Gateway-Provider': result.provider.id,
      'X-Gateway-Model': body.model,
      'X-Gateway-Provider-Model': result.providerModel,
      'X-Gateway-Attempts': result.attempted.join(','),
    });
  } catch (err) {
    return sendOpenAIError(res, err.statusCode || 502, err.message, err.code || 'all_providers_failed');
  }
}

function providerModelForSafe(provider, model) {
  return (provider.modelAliases && provider.modelAliases[model]) || model;
}

function handleModels(req, res) {
  const auth = authenticate(req);
  if (!auth.ok) return sendOpenAIError(res, auth.status, auth.message, 'invalid_api_key');
  const seen = new Map();
  for (const p of store.data.providers) {
    if (!isUsable(p)) continue;
    for (const m of p.models || []) {
      if (!seen.has(m)) seen.set(m, { id: m, object: 'model', created: 0, owned_by: p.id });
    }
  }
  // Also expose routed model names that are not in any provider list.
  for (const m of Object.keys(store.data.routes || {})) {
    if (!seen.has(m)) seen.set(m, { id: m, object: 'model', created: 0, owned_by: 'gateway' });
  }
  sendJson(res, 200, { object: 'list', data: [...seen.values()] });
}

// ---- Dashboard API -------------------------------------------------------
async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // api, <resource>, <id>, <action>

  // GET /api/status — everything the dashboard needs on load.
  if (req.method === 'GET' && pathname === '/api/status') {
    const entries = readUsage(store, 1000);
    return sendJson(res, 200, {
      settings: store.data.settings,
      presets: PRESETS,
      providers: store.data.providers.map(publicProvider),
      keys: store.data.keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, useCount: k.useCount || 0, revoked: k.revoked })),
      routes: store.data.routes || {},
      defaultFallback: store.data.defaultFallback || [],
      stats: computeStats(entries),
      recent: entries.slice(-50).reverse(),
      hasAnyKey: store.data.keys.some((k) => !k.revoked),
      hasUsableProvider: store.data.providers.some(isUsable),
    });
  }

  if (req.method === 'GET' && pathname === '/api/usage') {
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
    const entries = readUsage(store, limit);
    return sendJson(res, 200, { stats: computeStats(entries), entries: entries.slice().reverse() });
  }

  // Providers
  if (pathname === '/api/providers' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.id || !body.name || !body.baseUrl) return sendJson(res, 400, { error: 'id, name and baseUrl are required.' });
    if (store.data.providers.some((p) => p.id === body.id)) return sendJson(res, 409, { error: `A provider with id "${body.id}" already exists.` });
    const provider = {
      id: String(body.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      name: String(body.name), baseUrl: String(body.baseUrl).replace(/\/$/, ''),
      apiKey: String(body.apiKey || ''),
      models: Array.isArray(body.models) ? body.models.filter(Boolean) : String(body.models || '').split(',').map((s) => s.trim()).filter(Boolean),
      modelAliases: body.modelAliases || {},
      enabled: body.enabled !== false, createdAt: new Date().toISOString(), health: undefined,
    };
    provider.health = { status: 'unknown', lastSuccessAt: null, lastErrorAt: null, lastError: null, lastStatusCode: null, consecutiveFailures: 0, totalRequests: 0, totalErrors: 0, cooldownUntil: null };
    store.data.providers.push(provider);
    if (!store.data.defaultFallback.includes(provider.id)) store.data.defaultFallback.push(provider.id);
    store.save();
    return sendJson(res, 201, publicProvider(provider));
  }
  if (parts[0] === 'api' && parts[1] === 'providers' && parts[2]) {
    const provider = store.data.providers.find((p) => p.id === parts[2]);
    if (!provider) return sendJson(res, 404, { error: 'Provider not found.' });
    if (req.method === 'DELETE') {
      store.data.providers = store.data.providers.filter((p) => p.id !== provider.id);
      store.data.defaultFallback = store.data.defaultFallback.filter((id) => id !== provider.id);
      for (const m of Object.keys(store.data.routes)) {
        store.data.routes[m] = store.data.routes[m].filter((id) => id !== provider.id);
        if (!store.data.routes[m].length) delete store.data.routes[m];
      }
      store.save();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'PUT') {
      let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      if (typeof body.name === 'string') provider.name = body.name;
      if (typeof body.baseUrl === 'string') provider.baseUrl = body.baseUrl.replace(/\/$/, '');
      if (typeof body.apiKey === 'string' && body.apiKey) provider.apiKey = body.apiKey; // empty = keep existing
      if (body.models !== undefined) provider.models = Array.isArray(body.models) ? body.models : String(body.models).split(',').map((s) => s.trim()).filter(Boolean);
      if (body.modelAliases && typeof body.modelAliases === 'object') provider.modelAliases = body.modelAliases;
      if (typeof body.enabled === 'boolean') provider.enabled = body.enabled;
      store.save();
      return sendJson(res, 200, publicProvider(provider));
    }
  }

  // Unified keys — plaintext is returned ONLY in the create/regenerate
  // response, once. Afterwards only the prefix + hash are stored.
  if (pathname === '/api/keys' && req.method === 'POST') {
    let body = {}; try { body = await readBody(req); } catch { body = {}; }
    const { record, plaintext } = createKeyRecord(body.name);
    store.data.keys.push(record);
    store.save();
    return sendJson(res, 201, { ...record, key: plaintext, warning: 'This key is shown ONCE. Copy it now — it cannot be retrieved again.' });
  }
  if (parts[0] === 'api' && parts[1] === 'keys' && parts[2]) {
    const key = store.data.keys.find((k) => k.id === parts[2]);
    if (!key) return sendJson(res, 404, { error: 'Key not found.' });
    if (req.method === 'DELETE') { key.revoked = true; store.save(); return sendJson(res, 200, { ok: true }); }
    if (req.method === 'POST' && parts[3] === 'regenerate') {
      const { record, plaintext } = createKeyRecord(key.name);
      record.id = key.id; // keep the same id so clients referencing it keep working
      const idx = store.data.keys.findIndex((k) => k.id === key.id);
      store.data.keys[idx] = record;
      store.save();
      return sendJson(res, 200, { ...record, key: plaintext, warning: 'This key is shown ONCE. Copy it now — it cannot be retrieved again.' });
    }
  }

  // Routing
  if (pathname === '/api/routes' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (body.routes && typeof body.routes === 'object') {
      const clean = {};
      for (const [model, list] of Object.entries(body.routes)) {
        const ids = (Array.isArray(list) ? list : []).filter((id) => store.data.providers.some((p) => p.id === id));
        if (model && ids.length) clean[model] = ids;
      }
      store.data.routes = clean;
    }
    if (Array.isArray(body.defaultFallback)) {
      store.data.defaultFallback = body.defaultFallback.filter((id) => store.data.providers.some((p) => p.id === id));
    }
    if (typeof body.defaultModel === 'string' && body.defaultModel) store.data.settings.defaultModel = body.defaultModel;
    store.save();
    return sendJson(res, 200, { routes: store.data.routes, defaultFallback: store.data.defaultFallback, defaultModel: store.data.settings.defaultModel });
  }

  // Test a request through the gateway (dashboard only, localhost).
  if (pathname === '/api/test' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.model || !body.prompt) return sendJson(res, 400, { error: 'model and prompt are required.' });
    try {
      const result = await routeChatCompletion(store, {
        model: body.model,
        body: { model: body.model, messages: [{ role: 'user', content: String(body.prompt) }], max_tokens: Number(body.max_tokens) || 512, temperature: 0.7 },
        keyId: 'dashboard-test',
      });
      const choice = result.data?.choices?.[0];
      return sendJson(res, 200, {
        provider: result.provider.id, providerModel: result.providerModel, attempted: result.attempted,
        reply: choice?.message?.content ?? choice?.text ?? '', usage: result.usage, latencyMs: result.latencyMs, raw: result.data,
      });
    } catch (err) {
      return sendJson(res, err.statusCode || 502, { error: err.message, attempted: err.attempted || [] });
    }
  }

  return sendJson(res, 404, { error: 'Unknown API route.' });
}

// ---- Server --------------------------------------------------------------
// The request handler is a named function so serverless adapters (Vercel)
// can reuse it without starting a listening server. Local runs still
// listen on HOST:PORT below — except on Vercel, where the platform
// invokes the handler directly (process.env.VERCEL is set there).
async function handleRequest(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    if (pathname === '/health') return sendJson(res, 200, { status: 'ok', service: 'free-llm-gateway', version: '1.0.0', providers: store.data.providers.length, usableProviders: store.data.providers.filter(isUsable).length });
    if (pathname === '/v1/models' && req.method === 'GET') return handleModels(req, res);
    if (pathname === '/v1/chat/completions' && req.method === 'POST') return handleChatCompletions(req, res);
    if (pathname === '/v1/completions' && req.method === 'POST') {
      // Legacy completions: adapt prompt -> chat message, then route as chat.
      const auth = authenticate(req);
      if (!auth.ok) return sendOpenAIError(res, auth.status, auth.message, 'invalid_api_key');
      let body; try { body = await readBody(req); } catch (e) { return sendOpenAIError(res, 400, e.message, 'invalid_request'); }
      if (!body.model || !body.prompt) return sendOpenAIError(res, 400, 'model and prompt are required.', 'invalid_request');
      const chatBody = { model: body.model, messages: [{ role: 'user', content: String(body.prompt) }], max_tokens: body.max_tokens, temperature: body.temperature, stream: body.stream };
      try {
        const result = await routeChatCompletion(store, { model: body.model, body: chatBody, keyId: auth.key.id });
        const choice = result.data?.choices?.[0];
        return sendJson(res, 200, { id: result.data.id, object: 'text_completion', created: result.data.created, model: body.model, choices: [{ text: choice?.message?.content ?? '', index: 0, finish_reason: choice?.finish_reason ?? null }], usage: result.data.usage });
      } catch (err) { return sendOpenAIError(res, err.statusCode || 502, err.message, err.code || 'all_providers_failed'); }
    }
    if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
    if (pathname === '/' || pathname === '/index.html') return serveStatic(req, res, path.join(PUBLIC_DIR, 'index.html'));
    if (pathname === '/styles.css') return serveStatic(req, res, path.join(PUBLIC_DIR, 'styles.css'));
    if (pathname === '/dashboard.js') return serveStatic(req, res, path.join(PUBLIC_DIR, 'dashboard.js'));
    return sendJson(res, 404, { error: 'Not found. Dashboard is at /, API docs in README.md.' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error', detail: err.message });
  }
}

const server = http.createServer(handleRequest);

if (!process.env.VERCEL) server.listen(PORT, HOST, () => {
  const usable = store.data.providers.filter(isUsable);
  console.log('');
  console.log('  Free LLM Gateway — self-hosted unified LLM router');
  console.log(`  Dashboard:  http://${HOST}:${PORT}/`);
  console.log(`  API base:   http://${HOST}:${PORT}/v1`);
  console.log(`  Providers:  ${store.data.providers.length} configured, ${usable.length} usable (with a real key)`);
  console.log(`  Unified keys: ${store.data.keys.filter((k) => !k.revoked).length} active`);
  if (!usable.length) console.log('  → No provider has a real API key yet. Open the dashboard and add one,');
  if (!store.data.keys.some((k) => !k.revoked)) console.log('    or copy config.example.json to config.json, add keys, and restart.');
  console.log('    then generate a unified key in the dashboard to start calling /v1/chat/completions.');
  console.log('');
});

export { server, store, handleRequest };
