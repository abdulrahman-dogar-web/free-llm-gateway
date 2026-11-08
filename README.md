# Free LLM Gateway

A **self-hosted unified LLM gateway** — your own OpenRouter clone, running entirely on your machine.

You paste your provider API keys once (Groq, OpenRouter, Together, Mistral, Google Gemini, Cloudflare Workers AI, or any OpenAI-compatible provider). The gateway issues **one unified API key**. Every client — `curl`, the OpenAI Python/JS SDK, or any OpenAI-compatible app — talks to the gateway with that one key, and the gateway routes the request to a working provider, falling back automatically when a provider is rate-limited, out of quota, or down.

> **Important: this gateway gives you no free tokens itself.** It is a router, not a provider. You bring your own provider keys (including their free tiers); the gateway only spends what those keys allow. If a provider has no free tier left, the gateway cannot invent tokens for it — it will rotate to the next provider you configured.

## Features

- **One unified key** — generated locally, shown once, stored only as a SHA-256 hash. Generate, revoke, and regenerate from the dashboard.
- **OpenAI-compatible API** — `POST /v1/chat/completions`, `POST /v1/completions` (legacy), `GET /v1/models`. Works with the OpenAI SDK and any OpenAI-compatible client by pointing `base_url` at `http://localhost:8787/v1`.
- **Provider adapters** — every provider is just `{ id, name, baseUrl, apiKey, models }`. Any OpenAI-compatible endpoint works; six presets ship out of the box (Groq, OpenRouter, Together, Mistral, Gemini via its OpenAI-compatible endpoint, Cloudflare Workers AI).
- **Model routing with fallback** — map a model name to an ordered provider list (`routes`), plus a global default fallback order. If a provider returns 429 / quota / 5xx or a network error, it is marked down and the next provider is tried immediately.
- **Key rotation / cooldown** — an exhausted provider is put in cooldown (default 60 s, configurable) and skipped until it recovers. Provider health (up / down / cooldown / unknown, last error, consecutive failures) is visible on the dashboard.
- **Token usage tracking** — every request is logged to `data/usage.jsonl` (model, provider, prompt/completion tokens from the provider's `usage` field, latency, timestamp, status). The dashboard shows totals, per-provider and per-model breakdowns, and recent requests.
- **Streaming** — `stream: true` requests are forwarded as server-sent events from the first provider that streams successfully, with fallback to the next provider if streaming fails to start.
- **Web dashboard** — provider list with status, add/edit/disable/delete providers, unified-key management, routing editor, usage tables, and a test-a-request form.
- **Zero dependencies** — Node.js built-ins only (`node:http`, `fetch`, `crypto`, `fs`). `npm install` is instant and there is nothing to audit or update.

## Architecture

```
Client (curl / OpenAI SDK / any OpenAI-compatible app)
        │  Authorization: Bearer <unified-key>
        ▼
Free LLM Gateway  (Node.js, no framework)  ── Dashboard at http://localhost:8787/
  ├─ src/app.js        HTTP server, /v1/* + /api/* + static dashboard
  ├─ src/router.js     model → provider resolution, fallback loop, cooldown
  ├─ src/providers.js  OpenAI-compatible adapter, health tracking
  ├─ src/store.js      local persistence (store.json + usage.jsonl)
  └─ public/           dashboard (index.html, styles.css, dashboard.js)
        │  Authorization: Bearer <provider-key>
        ▼
Groq / OpenRouter / Together / Mistral / Gemini / Cloudflare / any OpenAI-compatible API
```

Data flow for one chat request:

1. The gateway checks the `Bearer` unified key (hashed comparison; revoked keys get 401).
2. The router resolves the model: explicit `routes[model]`, else providers that list the model, else all enabled providers — in `defaultFallback` order, skipping providers in cooldown.
3. Each provider is tried in order. On 429/quota/5xx/network failure the provider is cooled down and the next one is tried. On 400/404/422 the error is returned immediately (the request itself is wrong — retrying everywhere would not help).
4. On success the provider's response is returned unchanged, with `X-Gateway-Provider`, `X-Gateway-Model`, `X-Gateway-Provider-Model`, and `X-Gateway-Attempts` headers, and the usage is logged.

## Setup

Requires Node.js **18+** (uses the built-in `fetch`).

```bash
npm install   # zero dependencies — installs nothing, just verifies the manifest
cp config.example.json config.json
# Edit config.json: replace YOUR_*_HERE keys with your OWN provider keys.
# Delete any provider block you do not use, or leave it — placeholder keys
# are ignored and that provider is shown as "missing key" in the dashboard.
npm start
```

Then open **http://127.0.0.1:8787/**

1. If you did not use `config.json`, add providers in the dashboard (pick a preset, paste the key, list its models).
2. Click **Generate key** under "Unified API key" and copy the key — **it is shown once** and cannot be retrieved again (only its hash is stored). Regenerate if you lose it.
3. Call the gateway with that key (below).

You can also configure everything through environment variables — see `.env.example` (`PORT`, `HOST`, `COOLDOWN_SECONDS`, `REQUEST_TIMEOUT_MS`, `CONFIG_PATH`, `DATA_DIR`). Copy it to `.env` if you use it.

### Config file format

`config.json` (gitignored) seeds the gateway on first start; the dashboard can edit everything afterwards. See `config.example.json` — it documents every field, including `routes` and `defaultFallback`:

```json
{
  "port": 8787,
  "providers": [
    { "id": "groq", "name": "Groq", "baseUrl": "https://api.groq.com/openai/v1",
      "apiKey": "gsk_…", "models": ["llama-3.3-70b-versatile"] }
  ],
  "routes": { "llama-3.3-70b-versatile": ["groq", "together", "openrouter"] },
  "defaultFallback": ["groq", "openrouter", "together"]
}
```

Model names can differ per provider: add `"modelAliases": { "my-model": "provider-actual-model" }` to a provider to translate the gateway model name into the name that provider expects.

## Usage

### curl

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_UNIFIED_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "llama-3.3-70b-versatile", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="YOUR_UNIFIED_KEY")
resp = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

### OpenAI Node.js SDK

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "YOUR_UNIFIED_KEY" });
const resp = await client.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);
```

### List available models

```bash
curl http://localhost:8787/v1/models -H "Authorization: Bearer YOUR_UNIFIED_KEY"
```

### Health check (no auth)

```bash
curl http://localhost:8787/health
```

## Dashboard

| Section | What you can do |
|---|---|
| Providers | See status (up / down / cooldown / unknown), key preview, models, last error; add (with presets), enable/disable, delete |
| Unified API key | Generate (shown once), revoke, regenerate; copy-paste `curl` example |
| Model routing & fallback | Per-model fallback order, default fallback order, default model |
| Test a request | Pick a model, type a prompt, see the reply, which provider answered, latency, and tokens |
| Usage | Totals, per-provider and per-model tables, recent requests (from `data/usage.jsonl`) |

## Security notes

- **Keys never leave your machine.** Provider keys and the unified key live in `config.json` / `data/store.json` on local disk. The gateway only sends a provider key to that provider's own API, over HTTPS, exactly as a direct client would.
- **Never commit `config.json`, `.env`, or `data/`.** All three are in `.gitignore`. The repo ships only `config.example.json` / `.env.example`, which contain placeholder keys, never real ones. Unified keys are stored as SHA-256 hashes — even the store file cannot be used to recover one.
- **The dashboard has no login.** It is protected by binding to `127.0.0.1` by default — only this machine can reach it. Do not set `HOST=0.0.0.0` on a shared network unless you put a reverse proxy with authentication in front of it.
- **Treat the unified key like a password.** Anyone who has it can spend your providers' quotas through the gateway. Revoke and regenerate it if it leaks.
- **The gateway does not validate provider responses beyond parsing them** — it forwards the provider's JSON to you. Keep Node.js up to date.

## Files

| File | Purpose |
|---|---|
| `package.json` | Manifest, `npm start` / `npm test` scripts (zero dependencies) |
| `server.js` | Entry point — loads `src/app.js` |
| `src/app.js` | HTTP server: `/v1/*`, `/api/*`, static dashboard, streaming |
| `src/router.js` | Model routing, fallback loop, cooldown/rotation |
| `src/providers.js` | OpenAI-compatible adapter, presets, health tracking |
| `src/store.js` | Persistence: providers, hashed keys, routes, usage log |
| `public/index.html`, `public/styles.css`, `public/dashboard.js` | Dashboard |
| `config.example.json` | Example config — copy to `config.json`, add your own keys |
| `.env.example` | Optional environment variables |
| `scripts/test-mock.js` | Mock-provider test: proves fallback works with no real keys |
| `README.md`, `LICENSE`, `.gitignore` | Docs, MIT licence, secret hygiene |

## Testing

No real API key is needed to verify the gateway:

```bash
npm test
```

`scripts/test-mock.js` starts two fake providers on localhost — one that always answers `429 quota exceeded`, one that answers a normal chat completion — points a throwaway gateway instance (temporary `data/` directory, random port) at them, and asserts:

1. `GET /v1/models` returns the configured models (with a unified key; 401 without one).
2. `POST /v1/chat/completions` falls back from the exhausted provider to the healthy one and returns its reply, with `X-Gateway-Provider` naming the healthy provider.
3. The exhausted provider is left in cooldown, the usage log records both the error and the success, and the dashboard (`GET /`) loads.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Invalid or revoked unified API key` | Generate a fresh key in the dashboard; the old one may have been revoked/regenerated. Keys are shown once — if you lost it, regenerate. |
| `503 No provider is configured for this model` | Add a provider with a real key that lists that model, or add an explicit route for it. Placeholder keys (`YOUR_…_HERE`) are ignored. |
| `502 All providers failed` | Check the dashboard: each provider shows its last error (e.g. 401 = wrong provider key, 429 = quota exhausted). Fix the key or wait out the cooldown. |
| Dashboard shows "No usable provider" | The provider has no key yet — paste one in the dashboard edit form, or in `config.json` and restart. |
| Port already in use | Set `PORT=8899` in `.env` or `config.json` and restart. |

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Mr. Abdul Rahman Dogar.
