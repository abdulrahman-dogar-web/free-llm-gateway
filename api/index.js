// api/index.js — Vercel serverless adapter for Free LLM Gateway.
// © 2026 Mr. Abdul Rahman Dogar
//
// Vercel's filesystem is ephemeral and read-only except /tmp, so the
// gateway's on-disk store (data/store.json) and config live under /tmp
// here. That means dashboard changes (added providers, generated keys)
// survive only while the function instance is warm. Durable config
// comes from ENVIRONMENT VARIABLES, re-seeded on every cold start:
//
//   ADMIN_TOKEN        (required on Vercel) — protects the /api/* admin
//                      endpoints. The dashboard prompts for it once and
//                      keeps it in sessionStorage. Without it, /api/*
//                      answers 503 so the admin API is never left open.
//   FLG_UNIFIED_KEY    (recommended) — a unified API key (flg_...) that
//                      is seeded on every cold start, so clients keep
//                      working across cold starts.
//   FLG_PROVIDERS_JSON (optional) — a JSON array of provider objects
//                      ({id, name, baseUrl, apiKey, models, enabled}).
//   GROQ_API_KEY, OPENROUTER_API_KEY, TOGETHER_API_KEY, MISTRAL_API_KEY,
//   GEMINI_API_KEY, CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID)
//                      — one env var per preset provider; each is seeded
//                      as a provider on every cold start.
//
// /v1/* stays protected by the unified Bearer key exactly as in the
// local server. Static dashboard files are served by Vercel from public/.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP = '/tmp/flg';
process.env.DATA_DIR = process.env.DATA_DIR || path.join(TMP, 'data');
process.env.CONFIG_PATH = process.env.CONFIG_PATH || path.join(TMP, 'config.json');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const PRESET_ENV = {
  groq: { env: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', name: 'Groq', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'] },
  openrouter: { env: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', name: 'OpenRouter', models: ['openai/gpt-4o-mini', 'meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-flash-1.5'] },
  together: { env: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1', name: 'Together AI', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'] },
  mistral: { env: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', name: 'Mistral AI', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-7b', 'codestral-latest'] },
  gemini: { env: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', name: 'Google Gemini (OpenAI-compatible)', models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'] },
  cloudflare: { env: 'CLOUDFLARE_API_TOKEN', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/v1', name: 'Cloudflare Workers AI', models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/qwen/qwen2.5-coder-32b-instruct', '@cf/mistral/mistral-7b-instruct-v0.3'] },
};

function seedConfig() {
  let providers = [];
  if (process.env.FLG_PROVIDERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.FLG_PROVIDERS_JSON);
      if (Array.isArray(parsed)) providers = parsed;
    } catch { /* invalid JSON — fall through to per-provider env vars */ }
  }
  if (!providers.length) {
    for (const [id, p] of Object.entries(PRESET_ENV)) {
      const key = (process.env[p.env] || '').trim();
      if (!key) continue;
      let baseUrl = p.baseUrl;
      if (id === 'cloudflare') {
        const acct = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
        if (!acct) continue; // Cloudflare needs a real account id in the URL.
        baseUrl = baseUrl.replace('{ACCOUNT}', acct);
      }
      providers.push({ id, name: p.name, baseUrl, apiKey: key, models: p.models, enabled: true });
    }
  }
  const config = {
    port: 8787,
    host: '0.0.0.0',
    cooldownSeconds: 60,
    requestTimeoutMs: 60000,
    defaultModel: 'llama-3.3-70b-versatile',
    defaultFallback: providers.map((p) => p.id),
    providers,
    routes: {},
  };
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return providers.length;
}
seedConfig();

const { handleRequest, store } = await import('../src/app.js');
const { sha256 } = await import('../src/store.js');

// Seed the unified key from the environment so it survives cold starts.
if (process.env.FLG_UNIFIED_KEY) {
  const plaintext = process.env.FLG_UNIFIED_KEY.trim();
  const hash = sha256(plaintext);
  const existing = store.data.keys.find((k) => k.hash === hash && !k.revoked);
  if (!existing) {
    store.data.keys.push({
      id: crypto.randomBytes(8).toString('hex'),
      name: 'Vercel env key',
      prefix: plaintext.slice(0, 11),
      hash,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
      revoked: false,
    });
    store.save();
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  // Vercel may hand the function its own rewritten path (/api/index).
  let pathname = url.pathname;
  if (pathname === '/api/index') pathname = '/';
  if (pathname.startsWith('/api/index/')) pathname = pathname.slice('/api/index'.length);

  // Admin API protection (Vercel only — local runs keep their old behaviour).
  if (pathname.startsWith('/api/')) {
    const adminToken = (process.env.ADMIN_TOKEN || '').trim();
    if (!adminToken) {
      return sendJson(res, 503, { error: 'Admin API is disabled: set the ADMIN_TOKEN environment variable on this deployment, then use that token in the dashboard.' });
    }
    if (req.headers['x-admin-token'] !== adminToken) {
      return sendJson(res, 401, { error: 'Admin token required. Enter the ADMIN_TOKEN for this deployment in the dashboard.' });
    }
  }

  // Hand the (possibly normalised) URL to the gateway handler.
  req.url = pathname + url.search;
  return handleRequest(req, res);
}
