// test-mock.js — verifies routing + fallback with NO real API keys.
// Starts two fake OpenAI-compatible providers on localhost:
//   * mock-exhausted — always answers 429 "quota exceeded"
//   * mock-healthy   — answers a normal chat completion
// Then starts a throwaway gateway (temp data dir, random port) configured
// with both, and asserts the gateway falls back, logs usage, enforces
// unified-key auth, and serves the dashboard.
//
// Run: npm test

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function startMock(port, handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flg-test-'));
const dataDir = path.join(tmpDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const exhausted = await startMock(0, (_req, res) => {
  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Quota exceeded for this provider. Please try again later.', type: 'rate_limit_error', code: 'insufficient_quota' } }));
});
const healthy = await startMock(0, (_req, res, body) => {
  let parsed = {};
  try { parsed = JSON.parse(body); } catch {}
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-mock-1', object: 'chat.completion', created: 1700000000, model: parsed.model || 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the mock provider.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
  }));
});
const exhaustedPort = exhausted.address().port;
const healthyPort = healthy.address().port;

// Seed config for the throwaway gateway.
const configPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  port: 0, // replaced below with a fixed free port via env
  host: '127.0.0.1',
  cooldownSeconds: 60,
  providers: [
    { id: 'mock-exhausted', name: 'Mock Exhausted', baseUrl: `http://127.0.0.1:${exhaustedPort}`, apiKey: 'mock-key-exhausted', models: ['mock-model'], enabled: true },
    { id: 'mock-healthy', name: 'Mock Healthy', baseUrl: `http://127.0.0.1:${healthyPort}`, apiKey: 'mock-key-healthy', models: ['mock-model'], enabled: true },
  ],
  routes: { 'mock-model': ['mock-exhausted', 'mock-healthy'] },
  defaultFallback: ['mock-exhausted', 'mock-healthy'],
}, null, 2));

const GATEWAY_PORT = 18787;
const gateway = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GATEWAY_PORT), HOST: '127.0.0.1', CONFIG_PATH: configPath, DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gatewayLog = '';
gateway.stdout.on('data', (d) => { gatewayLog += d; });
gateway.stderr.on('data', (d) => { gatewayLog += d; });

async function waitForGateway() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const base = `http://127.0.0.1:${GATEWAY_PORT}`;
try {
  check('gateway starts', await waitForGateway(), gatewayLog.slice(-500));

  // 1. Dashboard loads.
  const dash = await fetch(`${base}/`);
  const dashText = await dash.text();
  check('dashboard loads (GET /)', dash.ok && dashText.includes('Free LLM Gateway') && dashText.includes('dashboard.js'));

  // 2. /v1/models requires a unified key.
  const noAuth = await fetch(`${base}/v1/models`);
  check('GET /v1/models without key → 401', noAuth.status === 401);

  // 3. Generate a unified key via the dashboard API (shown once).
  const keyRes = await fetch(`${base}/api/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test key' }) });
  const keyData = await keyRes.json();
  const unifiedKey = keyData.key;
  check('unified key generated and shown once', keyRes.status === 201 && typeof unifiedKey === 'string' && unifiedKey.startsWith('flg_'), `prefix=${String(unifiedKey).slice(0, 8)}`);

  const auth = { Authorization: `Bearer ${unifiedKey}`, 'Content-Type': 'application/json' };

  // 4. /v1/models lists the configured model.
  const models = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
  check('GET /v1/models lists mock-model', (models.data || []).some((m) => m.id === 'mock-model'), JSON.stringify(models.data));

  // 5. Chat completion: exhausted provider (429) -> fallback to healthy.
  const chatRes = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'Hi' }] }),
  });
  const chat = await chatRes.json();
  check('POST /v1/chat/completions succeeds via fallback', chatRes.status === 200 && chat.choices?.[0]?.message?.content === 'Hello from the mock provider.', `status=${chatRes.status} body=${JSON.stringify(chat).slice(0, 200)}`);
  check('X-Gateway-Provider names the healthy provider', chatRes.headers.get('x-gateway-provider') === 'mock-healthy', chatRes.headers.get('x-gateway-provider'));
  check('X-Gateway-Attempts shows both providers tried', (chatRes.headers.get('x-gateway-attempts') || '').includes('mock-exhausted') && (chatRes.headers.get('x-gateway-attempts') || '').includes('mock-healthy'), chatRes.headers.get('x-gateway-attempts'));

  // 6. Exhausted provider is now in cooldown; usage log has error + success.
  const status = await (await fetch(`${base}/api/status`)).json();
  const ex = status.providers.find((p) => p.id === 'mock-exhausted');
  check('exhausted provider marked cooldown after 429', ex?.health?.status === 'cooldown', `status=${ex?.health?.status}`);
  check('usage stats: 2 requests logged (1 error + 1 ok), 17 tokens', status.stats.totalRequests === 2 && status.stats.totalTokens === 17 && status.stats.totalErrors === 1, JSON.stringify(status.stats));
  const usageLines = fs.readFileSync(path.join(dataDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('usage.jsonl records provider + tokens per request', usageLines.length === 2 && usageLines[1].provider === 'mock-healthy' && usageLines[1].promptTokens === 10 && usageLines[1].completionTokens === 7);

  // 7. A bad unified key is rejected; a bad request is a 400, not a fallback loop.
  const badKey = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer flg_wrong', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'Hi' }] }) });
  check('wrong unified key → 401', badKey.status === 401);
  const badReq = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'mock-model', messages: [] }) });
  check('empty messages → 400', badReq.status === 400);
} finally {
  gateway.kill('SIGTERM');
  exhausted.close();
  healthy.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll mock tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
