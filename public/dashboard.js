// dashboard.js — Free LLM Gateway dashboard (vanilla JS, no dependencies).
// Talks only to the local /api/* endpoints on this same server.

const $ = (id) => document.getElementById(id);
let state = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  // On a hosted deployment the admin API is protected by ADMIN_TOKEN.
  // The dashboard asks for it once and keeps it in sessionStorage.
  const adminToken = sessionStorage.getItem('flg-admin-token');
  if (adminToken) headers['x-admin-token'] = adminToken;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && /admin token/i.test(data.error || '') && !opts._retried) {
    const t = prompt('Admin token required for this gateway dashboard (the ADMIN_TOKEN set on the deployment):');
    if (t && t.trim()) {
      sessionStorage.setItem('flg-admin-token', t.trim());
      return api(path, { ...opts, _retried: true });
    }
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function copyText(text, btn) {
  navigator.clipboard?.writeText(text).then(() => {
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = old; }, 1500); }
  }).catch(() => alert('Copy failed — select the key manually.'));
}

async function load() {
  state = await api('/api/status');
  render();
}

function render() {
  const { stats, providers } = state;
  $('stat-requests').textContent = fmt(stats.totalRequests);
  $('stat-tokens').textContent = fmt(stats.totalTokens);
  $('stat-split').textContent = `${fmt(stats.promptTokens)} / ${fmt(stats.completionTokens)}`;
  $('stat-errors').textContent = fmt(stats.totalErrors);
  const up = providers.filter((p) => p.health.status === 'up').length;
  const usable = providers.filter((p) => p.hasKey && p.enabled).length;
  $('stat-providers').textContent = `${up} up · ${usable} usable`;

  const pill = $('health-pill');
  if (!providers.length) { pill.textContent = 'No providers yet'; pill.className = 'pill warn'; }
  else if (!usable) { pill.textContent = 'No usable provider — add a key'; pill.className = 'pill warn'; }
  else if (up > 0 || providers.some((p) => p.health.status === 'unknown')) { pill.textContent = 'Gateway ready'; pill.className = 'pill ok'; }
  else { pill.textContent = 'All providers down / cooling down'; pill.className = 'pill warn'; }

  const banner = $('setup-banner');
  const steps = [];
  if (!usable) steps.push('Add at least one provider with a real API key below (or copy <code>config.example.json</code> to <code>config.json</code>, add keys, and restart).');
  if (!state.hasAnyKey) steps.push('Generate a unified API key — clients use that key, never your provider keys.');
  if (steps.length) { banner.innerHTML = `<strong>Setup needed:</strong> ${steps.join(' ')}`; banner.classList.remove('hidden'); }
  else banner.classList.add('hidden');

  renderProviders();
  renderKeys();
  renderRoutes();
  renderUsage();
  renderTestModels();
  renderPresets();
}

function renderProviders() {
  const list = $('provider-list');
  if (!state.providers.length) {
    list.innerHTML = '<div class="empty">No providers configured yet. Use the form below, or copy <code>config.example.json</code> to <code>config.json</code> and restart.</div>';
    return;
  }
  list.innerHTML = state.providers.map((p) => {
    const h = p.health;
    const status = h.status;
    const extra = status === 'cooldown' ? ` · back in ${h.cooldownSecondsRemaining}s` : '';
    const last = h.lastError ? `<div class="provider-meta">Last error: ${esc(h.lastError)}${h.lastStatusCode ? ` (HTTP ${h.lastStatusCode})` : ''} · ${timeAgo(h.lastErrorAt)}</div>` : '';
    return `<article class="provider">
      <div class="provider-top">
        <span><span class="dot ${esc(status)}"></span><span class="provider-name">${esc(p.name)}</span> <span class="muted">· ${esc(p.id)}</span></span>
        <span class="status ${esc(status)}">${esc(status)}${extra}</span>
      </div>
      <div class="provider-base">${esc(p.baseUrl)}</div>
      <div class="chips">${(p.models || []).map((m) => `<span class="chip">${esc(m)}</span>`).join('') || '<span class="muted">No models listed</span>'}</div>
      <div class="provider-meta">
        Key: ${p.hasKey ? esc(p.keyPreview) : '<strong style="color:#fca5a5">missing — add one to use this provider</strong>'}
        · ${h.totalRequests} requests · ${h.totalErrors} errors
        · last success: ${timeAgo(h.lastSuccessAt)}
      </div>
      ${last}
      <div class="provider-actions">
        <button class="btn btn-small" data-toggle="${esc(p.id)}" type="button">${p.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-small btn-danger" data-delete="${esc(p.id)}" type="button">Delete</button>
      </div>
    </article>`;
  }).join('');
  list.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const p = state.providers.find((x) => x.id === b.dataset.toggle);
    await api(`/api/providers/${p.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !p.enabled }) });
    await load();
  }));
  list.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete provider "${b.dataset.delete}"? Its routes will be removed too.`)) return;
    await api(`/api/providers/${b.dataset.delete}`, { method: 'DELETE' });
    await load();
  }));
}

function renderKeys() {
  const list = $('key-list');
  if (!state.keys.length) {
    list.innerHTML = '<li class="empty">No unified key yet. Generate one above — it is shown once.</li>';
    return;
  }
  list.innerHTML = state.keys.map((k) => `<li>
    <span><strong class="${k.revoked ? 'revoked' : ''}">${esc(k.name)}</strong>
    <span class="muted"> · ${esc(k.prefix)}… · created ${timeAgo(k.createdAt)} · used ${fmt(k.useCount)}×${k.lastUsedAt ? ` · last ${timeAgo(k.lastUsedAt)}` : ''}${k.revoked ? ' · revoked' : ''}</span></span>
    <span>
      ${k.revoked ? '' : `<button class="btn btn-small" data-regen="${esc(k.id)}" type="button">Regenerate</button>
      <button class="btn btn-small btn-danger" data-revoke="${esc(k.id)}" type="button">Revoke</button>`}
    </span>
  </li>`).join('');
  list.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Revoke this key? Clients using it will immediately get 401.')) return;
    await api(`/api/keys/${b.dataset.revoke}`, { method: 'DELETE' });
    await load();
  }));
  list.querySelectorAll('[data-regen]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Regenerate this key? The old key stops working immediately.')) return;
    const data = await api(`/api/keys/${b.dataset.regen}/regenerate`, { method: 'POST' });
    showOnceKey(data.key);
    await load();
  }));
}

function showOnceKey(key) {
  $('key-once-value').textContent = key;
  $('key-once').classList.remove('hidden');
  $('curl-example').textContent = `curl http://localhost:8787/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${state.settings.defaultModel || 'llama-3.3-70b-versatile'}", "messages": [{"role": "user", "content": "Hello!"}]}'`;
  $('key-once').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderRoutes() {
  const box = $('routes-list');
  const entries = Object.entries(state.routes || {});
  box.innerHTML = entries.length
    ? `<table class="table"><thead><tr><th>Model</th><th>Fallback order</th><th></th></tr></thead><tbody>${entries.map(([m, list]) => `<tr><td>${esc(m)}</td><td>${list.map(esc).join(' → ')}</td><td><button class="btn btn-small btn-danger" data-del-route="${esc(m)}" type="button">Delete</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No explicit routes yet — the gateway falls back to providers that list each model, in default order.</p>';
  box.querySelectorAll('[data-del-route]').forEach((b) => b.addEventListener('click', async () => {
    const routes = { ...state.routes }; delete routes[b.dataset.delRoute];
    await api('/api/routes', { method: 'POST', body: JSON.stringify({ routes }) });
    await load();
  }));
  $('default-fallback').value = (state.defaultFallback || []).join(', ');
  $('default-model').value = state.settings.defaultModel || '';
}

function renderUsage() {
  const { stats, recent } = state;
  const row = (name, v) => `<tr><td>${esc(name)}</td><td>${fmt(v.requests)}</td><td>${fmt(v.tokens)}</td><td>${fmt(v.errors)}</td></tr>`;
  $('usage-by-provider').innerHTML = Object.entries(stats.byProvider).map(([k, v]) => row(k, v)).join('') || '<tr><td colspan="4" class="muted">No requests yet.</td></tr>';
  $('usage-by-model').innerHTML = Object.entries(stats.byModel).map(([k, v]) => row(k, v)).join('') || '<tr><td colspan="4" class="muted">No requests yet.</td></tr>';
  $('usage-note').textContent = `${fmt(stats.totalRequests)} requests logged to data/usage.jsonl`;
  $('usage-recent').innerHTML = (recent || []).map((e) => `<tr>
    <td>${new Date(e.ts).toLocaleString()}</td><td>${esc(e.model)}</td><td>${esc(e.provider)}</td>
    <td>${fmt((e.promptTokens || 0) + (e.completionTokens || 0))}</td><td>${e.latencyMs ? `${fmt(e.latencyMs)} ms` : '—'}</td>
    <td>${e.status === 'ok' ? '<span class="badge-ok">ok</span>' : `<span class="badge-err">error</span><br><span class="muted">${esc(e.error || '')}</span>`}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="muted">No requests yet — send a test request above.</td></tr>';
}

function renderTestModels() {
  const models = new Set();
  state.providers.forEach((p) => (p.models || []).forEach((m) => models.add(m)));
  Object.keys(state.routes || {}).forEach((m) => models.add(m));
  if (state.settings.defaultModel) models.add(state.settings.defaultModel);
  const sel = $('test-model');
  const current = sel.value;
  sel.innerHTML = [...models].map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('') || '<option value="">(no models configured)</option>';
  if (current && models.has(current)) sel.value = current;
  else if (state.settings.defaultModel) sel.value = state.settings.defaultModel;
}

function renderPresets() {
  const sel = $('preset-select');
  if (sel.options.length) return;
  sel.innerHTML = '<option value="">Choose a preset…</option>' + state.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.addEventListener('change', () => {
    const p = state.presets.find((x) => x.id === sel.value);
    if (!p) return;
    $('p-name').value = p.name; $('p-id').value = p.id;
    $('p-base').value = p.baseUrl; $('p-models').value = p.models.join(', ');
    if (p.id === 'cloudflare') $('p-base').value = 'https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1';
  });
}

// ---- forms ----------------------------------------------------------------
$('add-provider-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('add-provider-msg'); msg.className = 'form-msg'; msg.textContent = 'Adding…';
  try {
    await api('/api/providers', { method: 'POST', body: JSON.stringify({
      id: $('p-id').value.trim(), name: $('p-name').value.trim(), baseUrl: $('p-base').value.trim(),
      apiKey: $('p-key').value.trim(), models: $('p-models').value,
    }) });
    msg.textContent = 'Provider added.';
    e.target.reset(); $('preset-select').value = '';
    await load();
  } catch (err) { msg.textContent = err.message; msg.className = 'form-msg error'; }
});

$('new-key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: $('key-name').value.trim() }) });
  showOnceKey(data.key);
  $('key-name').value = '';
  await load();
  // Re-show after load() re-renders (load does not clear the once box).
  $('key-once-value').textContent = data.key;
  $('key-once').classList.remove('hidden');
});

$('key-once-copy').addEventListener('click', (e) => copyText($('key-once-value').textContent, e.currentTarget));

$('route-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const routes = { ...state.routes };
  routes[$('route-model').value.trim()] = $('route-providers').value.split(',').map((s) => s.trim()).filter(Boolean);
  await api('/api/routes', { method: 'POST', body: JSON.stringify({ routes }) });
  e.target.reset();
  await load();
});

$('save-routing-btn').addEventListener('click', async () => {
  const msg = $('routing-msg');
  try {
    await api('/api/routes', { method: 'POST', body: JSON.stringify({
      defaultFallback: $('default-fallback').value.split(',').map((s) => s.trim()).filter(Boolean),
      defaultModel: $('default-model').value.trim(),
    }) });
    msg.textContent = 'Routing settings saved.'; msg.className = 'form-msg';
    await load();
  } catch (err) { msg.textContent = err.message; msg.className = 'form-msg error'; }
});

$('test-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('test-result');
  box.classList.remove('hidden', 'error');
  box.innerHTML = '<div class="meta">Sending…</div>';
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const data = await api('/api/test', { method: 'POST', body: JSON.stringify({ model: $('test-model').value, prompt: $('test-prompt').value }) });
    box.innerHTML = `<div class="meta">Provider: <strong>${esc(data.provider)}</strong> (${esc(data.providerModel)}) · tried: ${esc((data.attempted || []).join(' → '))} · ${fmt(data.latencyMs)} ms · tokens: ${fmt((data.usage?.promptTokens || 0) + (data.usage?.completionTokens || 0))}</div>${esc(data.reply || '(empty reply)')}`;
  } catch (err) {
    box.classList.add('error');
    box.textContent = `Request failed: ${err.message}`;
  } finally { btn.disabled = false; }
});

$('refresh-btn').addEventListener('click', load);
setInterval(load, 15000); // refresh health + usage every 15s

load().catch((err) => {
  $('health-pill').textContent = 'Dashboard failed to load';
  $('setup-banner').innerHTML = `<strong>Could not reach the gateway API:</strong> ${esc(err.message)}`;
  $('setup-banner').classList.remove('hidden');
});
