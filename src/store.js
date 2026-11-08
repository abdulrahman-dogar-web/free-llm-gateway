// store.js — local persistence for Free LLM Gateway.
// Everything lives on disk, on this machine only:
//   data/store.json  — providers, unified keys (SHA-256 hashes only),
//                      routing table, settings, provider health.
//   data/usage.jsonl — one JSON line per gateway request.
// No provider key and no unified key plaintext is ever written to a log.
// config.json (gitignored) is merged in on startup as a seed source.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PLACEHOLDER_KEYS = new Set([
  '',
  'YOUR_GROQ_API_KEY_HERE',
  'YOUR_OPENROUTER_API_KEY_HERE',
  'YOUR_TOGETHER_API_KEY_HERE',
  'YOUR_MISTRAL_API_KEY_HERE',
  'YOUR_GEMINI_API_KEY_HERE',
  'YOUR_CLOUDFLARE_API_TOKEN_HERE',
  'YOUR_API_KEY_HERE',
  'CHANGE_ME',
  'REPLACE_ME',
]);

export function isRealKey(key) {
  return typeof key === 'string' && key.trim().length > 0 && !PLACEHOLDER_KEYS.has(key.trim());
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function maskKey(key) {
  if (!key || key.length < 8) return '••••••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function defaultStore() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings: {
      port: 8787,
      host: '127.0.0.1',
      cooldownSeconds: 60,
      requestTimeoutMs: 60000,
      defaultModel: 'llama-3.3-70b-versatile',
    },
    providers: [],
    keys: [],
    routes: {},
    defaultFallback: [],
  };
}

export class Store {
  constructor(dataDir, configPath) {
    this.dataDir = dataDir;
    this.configPath = configPath;
    this.storePath = path.join(dataDir, 'store.json');
    this.usagePath = path.join(dataDir, 'usage.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.load();
    this.mergeConfigFile();
    this.save();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      const base = defaultStore();
      return { ...base, ...parsed, settings: { ...base.settings, ...(parsed.settings || {}) } };
    } catch {
      return defaultStore();
    }
  }

  save() {
    fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }

  // Merge config.json providers/routes/settings into the store.
  // config.json is a seed: a provider already present in the store keeps
  // its dashboard-edited values; a new one is imported. Placeholder keys
  // (YOUR_..._HERE) are never imported as real keys.
  mergeConfigFile() {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      return; // No config.json yet — dashboard-only setup. That's fine.
    }
    if (!cfg || typeof cfg !== 'object') return;
    const s = this.data.settings;
    if (Number.isFinite(cfg.port)) s.port = cfg.port;
    if (typeof cfg.host === 'string' && cfg.host) s.host = cfg.host;
    if (Number.isFinite(cfg.cooldownSeconds)) s.cooldownSeconds = cfg.cooldownSeconds;
    if (Number.isFinite(cfg.requestTimeoutMs)) s.requestTimeoutMs = cfg.requestTimeoutMs;
    if (typeof cfg.defaultModel === 'string' && cfg.defaultModel) s.defaultModel = cfg.defaultModel;
    if (Array.isArray(cfg.defaultFallback)) this.data.defaultFallback = cfg.defaultFallback;
    if (cfg.routes && typeof cfg.routes === 'object') {
      for (const [model, list] of Object.entries(cfg.routes)) {
        if (model.startsWith('_')) continue;
        if (Array.isArray(list) && !(model in this.data.routes)) this.data.routes[model] = list;
      }
    }
    if (Array.isArray(cfg.providers)) {
      for (const p of cfg.providers) {
        if (!p || typeof p !== 'object' || !p.id) continue;
        const existing = this.data.providers.find((x) => x.id === p.id);
        const models = Array.isArray(p.models)
          ? p.models.map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean)
          : [];
        if (!existing) {
          this.data.providers.push({
            id: String(p.id),
            name: p.name || String(p.id),
            baseUrl: String(p.baseUrl || '').replace(/\/$/, ''),
            apiKey: isRealKey(p.apiKey) ? String(p.apiKey) : '',
            models,
            modelAliases: p.modelAliases && typeof p.modelAliases === 'object' ? p.modelAliases : {},
            enabled: p.enabled !== false,
            createdAt: new Date().toISOString(),
            health: freshHealth(),
          });
        } else {
          // Fill in blanks only — never overwrite a dashboard-edited key.
          if (!existing.apiKey && isRealKey(p.apiKey)) existing.apiKey = String(p.apiKey);
          if (!existing.baseUrl && p.baseUrl) existing.baseUrl = String(p.baseUrl).replace(/\/$/, '');
          if (existing.models.length === 0 && models.length) existing.models = models;
          if (!existing.health) existing.health = freshHealth();
        }
      }
    }
    // Keep defaultFallback in sync with known providers.
    if (this.data.defaultFallback.length === 0) {
      this.data.defaultFallback = this.data.providers.map((p) => p.id);
    }
  }
}

export function freshHealth() {
  return {
    status: 'unknown', // unknown | up | down | cooldown
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastStatusCode: null,
    consecutiveFailures: 0,
    totalRequests: 0,
    totalErrors: 0,
    cooldownUntil: null,
  };
}

// ---- Unified keys -------------------------------------------------------
export function generateUnifiedKey() {
  // flg_ prefix so a leaked key is recognisable as a gateway key, not a
  // provider key. 32 random bytes -> 43 base64url chars.
  return `flg_${randomBytes(32).toString('base64url')}`;
}

export function createKeyRecord(name) {
  const plaintext = generateUnifiedKey();
  return {
    record: {
      id: randomBytes(8).toString('hex'),
      name: name || 'Default key',
      prefix: plaintext.slice(0, 11), // "flg_XXXXXXX" — safe to display
      hash: sha256(plaintext),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
      revoked: false,
    },
    plaintext,
  };
}

// ---- Usage log ----------------------------------------------------------
export function appendUsage(store, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(store.usagePath, line + '\n', 'utf8');
}

export function readUsage(store, limit = 500) {
  try {
    const raw = fs.readFileSync(store.usagePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

export function computeStats(entries) {
  const byProvider = {};
  const byModel = {};
  let totalRequests = 0, totalTokens = 0, promptTokens = 0, completionTokens = 0, totalErrors = 0;
  for (const e of entries) {
    totalRequests++;
    const pt = Number(e.promptTokens) || 0;
    const ct = Number(e.completionTokens) || 0;
    promptTokens += pt; completionTokens += ct; totalTokens += pt + ct;
    if (e.status === 'error') totalErrors++;
    const p = byProvider[e.provider || 'unknown'] ??= { requests: 0, tokens: 0, errors: 0 };
    p.requests++; p.tokens += pt + ct; if (e.status === 'error') p.errors++;
    const m = byModel[e.model || 'unknown'] ??= { requests: 0, tokens: 0, errors: 0 };
    m.requests++; m.tokens += pt + ct; if (e.status === 'error') m.errors++;
  }
  return { totalRequests, totalTokens, promptTokens, completionTokens, totalErrors, byProvider, byModel };
}
