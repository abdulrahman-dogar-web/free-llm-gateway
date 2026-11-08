# Deploying Free LLM Gateway

© 2026 Mr. Abdul Rahman Dogar

This is a Node.js server, not a static site, so it cannot be hosted on
GitHub Pages or plain static hosting. It needs a host that runs Node.

## Live deployment (Vercel, free Hobby tier)

The gateway is deployed on Vercel from this repo:
`api/index.js` is the serverless adapter (it reuses `src/app.js` without
starting a listening server), `vercel.json` routes every path to it, and
the dashboard in `public/` is served as static files.

**Live URL:** https://free-llm-gateway-tahqeeq.vercel.app/ — check `/health`
for `{"status":"ok"}`. Dashboard at `/`, API at `/v1`.

### Environment variables (set in Vercel → Project → Settings → Environment Variables)

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_TOKEN` | Yes | Protects the `/api/*` admin endpoints. The dashboard asks for it once and keeps it in sessionStorage. Without it, `/api/*` answers 503 so the admin API is never left open. |
| `FLG_UNIFIED_KEY` | Recommended | A unified API key (`flg_...`) seeded on every cold start, so clients keep working across cold starts. |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) | Optional | One env var per preset provider — each is seeded as a provider on every cold start. |
| `FLG_PROVIDERS_JSON` | Optional | A JSON array of full provider objects (advanced alternative to the per-provider vars). |

### Honest limits on Vercel free tier
- Vercel's filesystem is ephemeral: anything added in the dashboard
  (providers, generated keys, usage history) lives in `/tmp` and is
  lost when the function instance goes cold. **Durable config comes
  only from the environment variables above** — set provider keys and
  the unified key there, not only in the dashboard.
- Serverless functions have a request timeout (Hobby: 60s). Long
  streaming completions can be cut off; the gateway's default request
  timeout is 60s for the same reason.
- For fully durable storage (keys, usage history), run the gateway on
  Railway/Render (Option 2) or your own PC (Option 3) instead.

## Option 1 — Vercel (free tier, manual)
1. Import this repo in Vercel (or use the Vercel MCP connector).
2. Set `ADMIN_TOKEN` (and `FLG_UNIFIED_KEY` + provider keys) as
   environment variables before the first deploy.
3. Deploy. The dashboard is at the deployment URL `/`, the API at `/v1`.

## Option 2 — Railway / Render (free tier)
- Create a new service from this repo, start command `npm start`.
- Same rule: keys only via the dashboard / env vars. On these hosts
  the on-disk store is durable, so dashboard changes persist.

## Option 3 — any VPS / your own PC
```bash
npm install
cp config.example.json config.json   # add your OWN provider keys
npm start
```
The dashboard is then at http://localhost:8787/ (or your server's address).

The gateway gives you no free tokens itself — you bring your own
provider API keys.
