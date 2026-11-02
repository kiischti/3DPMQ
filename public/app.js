'use strict';
// ---------------------------------------------------------------- tiny helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const raw = (s) => ({ __raw: String(s) });
const val = (v) => (v && v.__raw !== undefined ? v.__raw : Array.isArray(v) ? v.map(val).join('') : v === false || v == null ? '' : esc(v));
const html = (s, ...v) => raw(s.reduce((a, x, i) => a + x + (i < v.length ? val(v[i]) : ''), ''));
const root = $('#root');
const mount = (el, tpl) => { el.innerHTML = tpl.__raw; };

const fmtDur = (s) => {
  if (s == null) return '–';
  if (s < 60) return '< 1 min';
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
};
const fmtG = (g) => (g == null ? '–' : `${Math.round(g)} g`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '–');
const swatch = (hex) => html`<span class="sw" style="background:${hex || '#ccc'}"></span>`;
const filLabel = (f) => (f ? html`${swatch(f.colour_hex)}${f.material} ${f.colour_name}` : '–');
const pill = (s) => html`<span class="pill ${s}">${s}</span>`;
const bar = (p) => html`<div class="bar"><i style="width:${Math.max(0, Math.min(100, p || 0))}%"></i></div>`;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4500);
}
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.data = data; e.status = r.status; throw e; }
  return data;
}
const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message); } };

// ---------------------------------------------------------------- state
let state = { printers: [], requests: [] };
let config = null;
let me = null; // staff name or null
const mine = () => JSON.parse(localStorage.getItem('mq_mine') || '{}'); // { id: token }
const remember = (id, token) => localStorage.setItem('mq_mine', JSON.stringify({ ...mine(), [id]: token }));

let es;
function connect() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.addEventListener('update', (e) => { state = JSON.parse(e.data); $('#conn').classList.add('on'); live(); });
  es.onerror = () => $('#conn').classList.remove('on');
}
async function loadConfig() { config = await api('GET', '/api/config'); }

// ---------------------------------------------------------------- router
const routes = { submit: renderSubmit, queue: renderQueue, printers: renderPrinters, staff: renderStaff };
function route() {
  const r = (location.hash.replace(/^#\//, '') || 'submit').split('/')[0];
  return routes[r] ? r : 'submit';
}
function render() {
  const r = route();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === r));
  routes[r]();
}
function live() { // called on every SSE update: only re-render views that show live data
  const r = route();
  if (r === 'submit') return;
  const a = document.activeElement;
  if (r === 'staff' && a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return; // don't wipe forms being edited
  routes[r]();
}
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- submit page
let analysis = null; // { file, meta, issues, ok }
function issuesHtml(issues) {
  return html`${issues.map((i) => html`<div class="issue ${i.level}">${{ error: '✗ ', warn: '⚠ ', info: 'ℹ ' }[i.level]}${i.message}</div>`)}`;
}
function metaHtml(m) {
  return html`<dl class="kv">
    <dt>Slicer</dt><dd>${m.generator || 'unknown'}</dd>
    <dt>Printer profile</dt><dd>${m.printerModel || '–'}</dd>
    <dt>Material</dt><dd>${m.filamentTypes.join(' / ') || '–'} ${m.filamentColours.map((c) => swatch(c))}</dd>
    <dt>Print time</dt><dd>${fmtDur(m.seconds)}</dd>
    <dt>Filament</dt><dd>${fmtG(m.grams)}</dd>
    <dt>Layer / nozzle</dt><dd>${m.layerHeight ?? '–'} mm / ${m.nozzleDiameter ?? '–'} mm</dd>
    <dt>Height</dt><dd>${m.maxZ ?? '–'} mm</dd>
  </dl>`;
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function nearestFilament(meta) {
  const mats = meta.filamentTypes.map((t) => t.toUpperCase());
  const cands = config.filaments.filter((f) => mats.includes(f.material.toUpperCase()));
  const want = meta.filamentColours[0];
  if (!cands.length) return null;
  if (!want || !/^#[0-9a-f]{6}$/i.test(want)) return cands[0];
  const w = hexRgb(want);
  return cands.map((f) => ({ f, d: hexRgb(f.colour_hex).reduce((a, v, i) => a + (v - w[i]) ** 2, 0) })).sort((a, b) => a.d - b.d)[0].f;
}

function renderSubmit() {
  if (!config) return void loadConfig().then(renderSubmit);
  const r = config.rules;
  const name = localStorage.getItem('mq_name') || '', email = localStorage.getItem('mq_email') || '';
  mount(root, html`
    <h1>Submit a print</h1>
    <div class="card">
      <p class="muted small" style="margin-top:0">Slice your model in PrusaSlicer, export the G-code (<b>Ctrl+G</b> / ⌘G), then drop it here.
        Allowed: ${r.allowedMaterials.join(', ')} · max ${r.maxHours || '∞'} h · max ${r.maxGrams || '∞'} g.
        ${config.printer_models.length ? html`Printers here: <b>${config.printer_models.join(', ')}</b>.` : ''}</p>
      <div class="drop" id="drop">Drop a <b>.gcode</b> or <b>.bgcode</b> file here, or click to choose<input type="file" id="file" accept=".gcode,.bgcode,.gco" hidden></div>
      <div id="result"></div>
    </div>
    <form class="card" id="form">
      <div class="cols2">
        <div><label for="name">Your name *</label><input id="name" name="name" required minlength="2" maxlength="80" value="${name}" autocomplete="name"></div>
        <div><label for="email">E-mail ${r.requireEmail ? '*' : '(optional – to tell you when it is ready)'}</label><input id="email" name="email" type="email" value="${email}" ${r.requireEmail ? 'required' : ''}></div>
      </div>
      <label for="filament">Filament *</label>
      <select id="filament" name="filamentId" required></select>
      <label for="notes">Notes for the staff (optional)</label>
      <textarea id="notes" name="notes" maxlength="1000"></textarea>
      <div class="row" style="margin-top:14px"><button class="primary" id="send" disabled>Send request</button><span class="muted small" id="hint">Choose a file first.</span></div>
    </form>`);
  fillFilaments();
  const drop = $('#drop'), file = $('#file');
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) analyse(e.dataTransfer.files[0]); };
  file.onchange = () => file.files[0] && analyse(file.files[0]);
  $('#filament').onchange = () => analysis && analyse(analysis.file, true);
  $('#form').onsubmit = send;
  analysis = null;
}
function fillFilaments(selectedId) {
  const sel = $('#filament'); if (!sel) return;
  const keep = selectedId ?? sel.value;
  sel.innerHTML = '<option value="">– choose –</option>' + config.filaments.map((f) =>
    `<option value="${f.id}">${esc(f.material)} – ${esc(f.colour_name)}</option>`).join('');
  if (keep) sel.value = keep;
}
async function analyse(file, keepFilament) {
  const res = $('#result');
  res.innerHTML = '<p class="muted">Checking file…</p>';
  const fd = new FormData(); fd.append('file', file);
  if (!keepFilament) $('#filament').value = ''; // a new file re-picks the filament from its own G-code
  const fsel = $('#filament').value; if (fsel) fd.append('filamentId', fsel);
  try {
    const r = await api('POST', '/api/validate', fd);
    analysis = { file, ...r };
    if (!keepFilament && r.meta && !fsel) { const f = nearestFilament(r.meta); if (f) $('#filament').value = f.id; if (f) return analyse(file, true); }
    mount(res, html`<h3 style="margin-top:14px">${file.name} <span class="muted small">(${(file.size / 1048576).toFixed(1)} MB)</span></h3>
      <div class="cols2"><div>${r.meta ? metaHtml(r.meta) : ''}</div><div>${issuesHtml(r.issues)}${r.ok ? html`<div class="issue info" style="background:var(--ok-bg);color:var(--ok)">✓ File passed the automatic checks.</div>` : ''}</div></div>`);
  } catch (e) { analysis = null; res.innerHTML = `<div class="issue error">${esc(e.message)}</div>`; }
  updateSend();
}
function updateSend() {
  const ok = analysis && analysis.ok && $('#filament').value;
  $('#send').disabled = !ok;
  $('#hint').textContent = !analysis ? 'Choose a file first.' : !analysis.ok ? 'Fix the problems above, re-slice, and drop the new file.' : !$('#filament').value ? 'Choose a filament.' : '';
}
async function send(e) {
  e.preventDefault();
  const f = e.target; const fd = new FormData(f); fd.append('file', analysis.file);
  localStorage.setItem('mq_name', f.name.value); localStorage.setItem('mq_email', f.email.value);
  $('#send').disabled = true;
  try {
    const r = await api('POST', '/api/requests', fd);
    remember(r.id, r.cancel_token);
    toast(`Request #${r.id} sent. Staff will review it.`);
    location.hash = '#/queue';
  } catch (err) {
    if (err.data?.issues) { $('#result').insertAdjacentHTML('beforeend', issuesHtml(err.data.issues).__raw); }
    toast(err.message); updateSend();
  }
}

// ---------------------------------------------------------------- queue page
function renderQueue() {
  const my = mine();
  const rows = state.requests;
  const open = rows.filter((r) => ['pending', 'approved', 'uploading', 'printing'].includes(r.status));
  const closed = rows.filter((r) => !open.includes(r)).slice(0, 40);
  const line = (r) => html`<tr>
    <td>#${r.id}</td><td>${r.user_name}</td><td>${filLabel(r.filament)}</td>
    <td class="small">${r.file_name}</td><td>${fmtG(r.grams)} · ${fmtDur(r.seconds)}</td>
    <td>${pill(r.status)}${r.status === 'approved' && r.queue_position ? html` <span class="muted small">#${r.queue_position} in line</span>` : ''}
      ${r.status === 'printing' ? html`<div style="min-width:120px">${bar(r.progress)}</div><span class="small muted">${r.printer_name || ''} ${r.progress != null ? Math.round(r.progress) + '%' : ''}</span>` : ''}
      ${r.status === 'rejected' ? html`<div class="small muted">${r.reject_reason}</div>` : ''}
      ${r.error && r.status !== 'done' ? html`<div class="small muted">${r.error}</div>` : ''}</td>
    <td>${my[r.id] && ['pending', 'approved'].includes(r.status) ? html`<button class="sm danger" data-act="cancel" data-id="${r.id}">Cancel</button>` : ''}</td></tr>`;
  const table = (list) => html`<table><thead><tr><th>#</th><th>Who</th><th>Filament</th><th>File</th><th>Size</th><th>Status</th><th></th></tr></thead><tbody>${list.map(line)}</tbody></table>`;
  mount(root, html`<h1>Print queue</h1>
    <div class="card">${open.length ? table(open) : html`<p class="muted">Nothing in the queue. <a href="#/submit">Submit a print</a>.</p>`}</div>
    ${closed.length ? html`<h2>Recently finished</h2><div class="card">${table(closed)}</div>` : ''}`);
}

// ---------------------------------------------------------------- printers page
function printerCard(p, staff) {
  const cur = p.current;
  return html`<div class="card" style="margin:0">
    <div class="row"><h3 style="margin:0">${p.name}</h3><span class="muted small">${p.model}${p.nozzle ? ` · ${p.nozzle} mm` : ''}</span><span class="right">${pill(p.enabled ? p.state : 'DISABLED')}</span></div>
    <div style="margin:10px 0">${p.state === 'PRINTING' || p.state === 'PAUSED' || p.progress ? html`${bar(p.progress)}<div class="small muted">${p.progress != null ? Math.round(p.progress) + '%' : ''} ${p.time_remaining != null ? '· ' + fmtDur(p.time_remaining) + ' left' : ''}</div>` : ''}</div>
    ${cur ? html`<div class="small">Job #${cur.request_id} · <b>${cur.user_name}</b><br><span class="muted">${cur.file_name}</span></div>` : ''}
    <div class="small muted" style="margin-top:8px">Nozzle ${p.temp_nozzle != null ? Math.round(p.temp_nozzle) + '°C' : '–'} · Bed ${p.temp_bed != null ? Math.round(p.temp_bed) + '°C' : '–'}</div>
    <div class="small" style="margin-top:4px">Loaded: ${p.loaded_filament ? filLabel(p.loaded_filament) : html`<span class="muted">not set</span>`}</div>
    ${!p.online && p.error ? html`<div class="small" style="color:var(--err)">${p.error}</div>` : ''}
    ${staff ? html`<div class="row" style="margin-top:10px">
      ${p.bed_clear ? html`<span class="pill approved">bed clear ✓</span><button class="sm" data-act="bed" data-id="${p.id}" data-v="0">Undo</button>` : html`<button class="sm ok" data-act="bed" data-id="${p.id}" data-v="1">Bed is clear</button>`}
      ${p.job_id != null && p.state === 'PRINTING' ? html`<button class="sm" data-act="pctl" data-id="${p.id}" data-a="pause">Pause</button>` : ''}
      ${p.state === 'PAUSED' ? html`<button class="sm" data-act="pctl" data-id="${p.id}" data-a="resume">Resume</button>` : ''}
      ${p.job_id != null && ['PRINTING', 'PAUSED'].includes(p.state) ? html`<button class="sm danger" data-act="pctl" data-id="${p.id}" data-a="stop">Stop</button>` : ''}</div>` : ''}
  </div>`;
}
function renderPrinters() {
  mount(root, html`<h1>Printers</h1>${state.printers.length ? html`<div class="grid">${state.printers.filter((p) => p.enabled).map((p) => printerCard(p, !!me))}</div>` : html`<p class="muted">No printers configured yet. Staff can add them on the Staff page.</p>`}`);
}

// ---------------------------------------------------------------- staff page
let tab = 'review';
const openPrinters = new Set();
let extra = { rules: null, filaments: null, audit: null };

async function renderStaff() {
  if (me === null) { const r = await api('GET', '/api/staff/me'); me = r.staff; if (me) connect(); }
  if (!me) {
    mount(root, html`<h1>Staff</h1><form class="card" id="login" style="max-width:380px">
      <label for="sn">Your name</label><input id="sn" name="name" maxlength="60" value="${localStorage.getItem('mq_staffname') || ''}">
      <label for="sp">Password</label><input id="sp" name="password" type="password" required>
      <div style="margin-top:14px"><button class="primary">Log in</button></div></form>`);
    $('#login').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      localStorage.setItem('mq_staffname', f.name.value);
      await act(async () => { const r = await api('POST', '/api/staff/login', { name: f.name.value, password: f.password.value }); me = r.name; connect(); renderStaff(); });
    };
    return;
  }
  if (tab === 'rules' && !extra.rules) extra.rules = await api('GET', '/api/staff/rules');
  if (tab === 'filaments' && !extra.filaments) extra.filaments = await api('GET', '/api/staff/filaments');
  if (tab === 'log' && !extra.audit) extra.audit = await api('GET', '/api/staff/audit');
  const pending = state.requests.filter((r) => r.status === 'pending');
  const ready = state.requests.filter((r) => r.status === 'approved');
  const tabs = [['review', `Review (${pending.length})`], ['ready', `Ready to print (${ready.length})`], ['printers', 'Printers'], ['filaments', 'Filaments'], ['rules', 'Rules'], ['log', 'Log']];
  const body = { review: () => staffReview(pending), ready: () => staffReady(ready), printers: staffPrinters, filaments: staffFilaments, rules: staffRules, log: staffLog }[tab]();
  mount(root, html`<div class="row"><h1 style="margin:0">Staff</h1><span class="muted small">logged in as ${me}</span><button class="sm right" data-act="logout">Log out</button></div>
    <div class="tabs" style="margin-top:12px">${tabs.map(([k, l]) => html`<button class="${k === tab ? 'active' : ''}" data-act="tab" data-t="${k}">${l}</button>`)}</div>${body}`);
}

function reqDetail(r) {
  const m = r.meta;
  return html`<div class="cols2"><div>
      <dl class="kv"><dt>From</dt><dd><b>${r.user_name}</b> ${r.user_email ? html`· <a href="mailto:${r.user_email}">${r.user_email}</a>` : ''}</dd>
        <dt>Filament</dt><dd>${filLabel(r.filament)}</dd><dt>Submitted</dt><dd>${fmtDate(r.created_at)}</dd>
        ${r.notes ? html`<dt>Notes</dt><dd>${r.notes}</dd>` : ''}</dl>${m ? metaHtml(m) : ''}</div>
    <div>${issuesHtml(r.issues || [])}</div></div>`;
}
function staffReview(list) {
  if (!list.length) return html`<p class="muted">No requests waiting for review.</p>`;
  return html`${list.map((r) => html`<div class="card"><div class="row"><h3 style="margin:0">#${r.id} · ${r.file_name}</h3><span class="muted small">${fmtG(r.grams)} · ${fmtDur(r.seconds)}</span>
      <span class="right row"><a class="btn sm" href="/api/staff/requests/${r.id}/file">Download G-code</a>
      <button class="sm" data-act="prio" data-id="${r.id}" data-d="1">▲</button><button class="sm" data-act="prio" data-id="${r.id}" data-d="-1">▼</button>
      <button class="sm danger" data-act="reject" data-id="${r.id}">Reject…</button><button class="sm primary" data-act="approve" data-id="${r.id}">Approve</button></span></div>
      ${reqDetail(r)}</div>`)}`;
}
function staffReady(list) {
  if (!list.length) return html`<p class="muted">Nothing approved and waiting.</p>`;
  return html`<p class="muted small">Order: priority, then approval time. "Start" uploads the G-code to the printer and begins printing – only press it when the bed is clear and the right filament is loaded.</p>
  ${list.map((r) => html`<div class="card"><div class="row"><h3 style="margin:0">#${r.id} · ${r.user_name}</h3><span>${filLabel(r.filament)}</span>
      <span class="muted small">${r.file_name} · ${fmtG(r.grams)} · ${fmtDur(r.seconds)}</span><span class="pill approved">#${r.queue_position} in line</span>
      <span class="right row"><button class="sm" data-act="prio" data-id="${r.id}" data-d="1">▲</button><button class="sm" data-act="prio" data-id="${r.id}" data-d="-1">▼</button>
      <button class="sm danger" data-act="reject" data-id="${r.id}">Reject…</button></span></div>
      ${r.error ? html`<div class="issue error">${r.error}</div>` : ''}
      <div class="row" style="margin-top:10px">${r.eligible.length
        ? r.eligible.map((p) => html`<button class="primary sm" data-act="start" data-id="${r.id}" data-p="${p.id}" ${p.available ? '' : 'disabled'}>Start on ${p.name}${p.available ? '' : ' (busy)'}</button>`)
        : html`<span class="muted small">No printer has ${filLabel(r.filament)} loaded.</span>
          ${state.printers.filter((p) => p.available).map((p) => html`<button class="sm" data-act="startany" data-id="${r.id}" data-p="${p.id}">Start on ${p.name} anyway</button>`)}`}</div></div>`)}`;
}
function staffPrinters() {
  const fils = extra.filaments || [];
  return html`${state.printers.map((p) => html`<div class="card">
    ${printerCard(p, true)}
    <div class="row" style="margin-top:10px"><label class="inline">Loaded filament
      <select data-act="loaded" data-id="${p.id}" style="width:auto"><option value="">–</option>${(config?.filaments || []).map((f) => html`<option value="${f.id}" ${p.loaded_filament?.id === f.id ? 'selected' : ''}>${f.material} ${f.colour_name}</option>`)}</select></label>
    </div>
    <details data-pid="${p.id}" ${openPrinters.has(p.id) ? 'open' : ''} style="margin-top:10px"><summary>Settings</summary>${printerForm(p)}</details></div>`)}
  <div class="card"><h3>Add printer</h3>${printerForm(null)}</div>`;
}
function printerForm(p) {
  const v = p || { name: '', base_url: 'http://', username: 'maker', storage: 'usb', model: '', nozzle: 0.4, enabled: true, auto_start: false };
  return html`<form data-form="printer" data-id="${p ? p.id : ''}"><div class="cols2">
    <div><label>Name</label><input name="name" required value="${v.name}"></div>
    <div><label>PrusaLink address</label><input name="base_url" required value="${v.base_url}" placeholder="http://192.168.1.50"></div>
    <div><label>Username</label><input name="username" value="${v.username}"></div>
    <div><label>Password / API key ${p ? '(leave empty to keep)' : ''}</label><input name="password" type="password" autocomplete="new-password"></div>
    <div><label>Printer model (as in the G-code, e.g. MK4S)</label><input name="model" value="${v.model}" required></div>
    <div><label>Nozzle (mm, optional)</label><input name="nozzle" type="number" step="0.05" value="${v.nozzle ?? ''}"></div>
    <div><label>Storage</label><input name="storage" value="${v.storage}"></div></div>
    <div class="row" style="margin-top:12px"><label class="inline"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}> Enabled</label>
      <label class="inline"><input type="checkbox" name="auto_start" ${v.auto_start ? 'checked' : ''}> Auto-start next job when "bed is clear" is set</label></div>
    <div class="row" style="margin-top:12px"><button class="primary sm">${p ? 'Save' : 'Add printer'}</button><button type="button" class="sm" data-act="ptest">Test connection</button>
      ${p ? html`<button type="button" class="sm danger right" data-act="pdel" data-id="${p.id}">Delete</button>` : ''}<span class="small muted" data-role="ptest-out"></span></div></form>`;
}
function staffFilaments() {
  const fl = extra.filaments || [];
  const rowF = (f) => html`<tr><td><input data-fil="${f?.id ?? ''}" data-k="material" value="${f?.material ?? ''}" placeholder="PLA" style="width:90px"></td>
    <td><input data-fil="${f?.id ?? ''}" data-k="colour_name" value="${f?.colour_name ?? ''}" placeholder="Colour name"></td>
    <td><input type="color" data-fil="${f?.id ?? ''}" data-k="colour_hex" value="${f?.colour_hex ?? '#cccccc'}"></td>
    <td><label class="inline"><input type="checkbox" data-fil="${f?.id ?? ''}" data-k="in_stock" ${!f || f.in_stock ? 'checked' : ''}> in stock</label></td>
    <td>${f ? html`<button class="sm" data-act="fsave" data-id="${f.id}">Save</button> <button class="sm danger" data-act="fdel" data-id="${f.id}">Delete</button>` : html`<button class="sm primary" data-act="fsave" data-id="">Add</button>`}</td></tr>`;
  return html`<p class="muted small">This list is what users can choose from, and what you assign to printers as "loaded".</p>
    <div class="card"><table><thead><tr><th>Material</th><th>Colour</th><th></th><th></th><th></th></tr></thead><tbody>${fl.map(rowF)}${rowF(null)}</tbody></table></div>`;
}
function staffRules() {
  const r = extra.rules;
  const num = (k, l, h = '') => html`<div><label>${l}</label><input type="number" min="0" step="any" name="${k}" value="${r[k]}"><div class="small muted">${h}</div></div>`;
  const chk = (k, l) => html`<label class="inline" style="margin-top:8px"><input type="checkbox" name="${k}" ${r[k] ? 'checked' : ''}> ${l}</label><br>`;
  return html`<form class="card" data-form="rules"><div class="cols2">
    <div><label>Allowed materials (comma separated)</label><input name="allowedMaterials" value="${r.allowedMaterials.join(', ')}"></div>
    ${num('maxHours', 'Max print time (hours)', '0 = no limit')}${num('maxGrams', 'Max filament per print (g)', '0 = no limit')}
    ${num('maxNozzleTemp', 'Max nozzle temperature (°C)')}${num('maxBedTemp', 'Max bed temperature (°C)')}
    ${num('maxActivePerUser', 'Max open requests per person', '0 = no limit')}${num('monthlyGramQuota', 'Monthly filament quota per person (g)', '0 = no limit')}
    ${num('maxFileMB', 'Max file size (MB)')}</div>
    ${chk('requirePrusaSlicer', 'Only accept files generated by PrusaSlicer')}${chk('allowMulticolor', 'Allow multi-material / multi-colour prints')}${chk('requireEmail', 'Require e-mail address')}
    <div style="margin-top:14px"><button class="primary">Save rules</button></div></form>`;
}
function staffLog() {
  return html`<div class="row"><a class="btn" href="/api/staff/export.csv">Export all requests (CSV)</a></div>
    <div class="card"><table><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Request</th><th>Detail</th></tr></thead><tbody>
    ${(extra.audit || []).map((a) => html`<tr><td class="small">${fmtDate(a.ts)}</td><td>${a.actor}</td><td>${a.action}</td><td>${a.request_id ?? ''}</td><td class="small muted">${a.detail}</td></tr>`)}</tbody></table></div>`;
}

// ---------------------------------------------------------------- delegated events
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const id = b.dataset.id, a = b.dataset.act;
  const refresh = () => renderStaff();
  const handlers = {
    cancel: () => act(() => api('POST', `/api/requests/${id}/cancel`, { token: mine()[id] }), 'Request cancelled'),
    logout: async () => { await api('POST', '/api/staff/logout'); me = null; connect(); renderStaff(); },
    tab: () => { tab = b.dataset.t; extra = { rules: null, filaments: null, audit: null }; refresh(); },
    approve: () => act(() => api('POST', `/api/staff/requests/${id}/approve`), `#${id} approved`),
    reject: () => { const reason = prompt('Reason for rejecting (shown to the user):'); if (reason) act(() => api('POST', `/api/staff/requests/${id}/reject`, { reason }), `#${id} rejected`); },
    prio: () => act(() => api('POST', `/api/staff/requests/${id}/priority`, { delta: +b.dataset.d })),
    start: () => confirm('Bed clear and correct filament loaded? The job will be uploaded and started now.') && act(() => api('POST', `/api/staff/requests/${id}/start`, { printerId: +b.dataset.p }), 'Uploading to printer…'),
    startany: () => confirm('The requested filament is NOT marked as loaded on this printer. Start anyway?') && act(() => api('POST', `/api/staff/requests/${id}/start`, { printerId: +b.dataset.p, ignoreFilament: true }), 'Uploading to printer…'),
    bed: () => act(() => api('POST', `/api/staff/printers/${id}/bed-clear`, { clear: b.dataset.v === '1' })),
    pctl: () => (b.dataset.a !== 'stop' || confirm('Stop the running print?')) && act(() => api('POST', `/api/staff/printers/${id}/${b.dataset.a}`)),
    pdel: () => confirm('Delete this printer?') && act(() => api('DELETE', `/api/staff/printers/${id}`), 'Printer deleted'),
    ptest: async () => {
      const f = b.closest('form'); const out = f.querySelector('[data-role=ptest-out]'); out.textContent = 'Testing…';
      const body = Object.fromEntries(new FormData(f)); body.id = f.dataset.id || undefined;
      const r = await api('POST', '/api/staff/printers/test', body).catch((x) => ({ ok: false, error: x.message }));
      out.textContent = r.ok ? `✓ connected, state ${r.state}` : `✗ ${r.error}`;
    },
    fsave: async () => {
      const fields = [...document.querySelectorAll(`[data-fil="${id}"]`)];
      const body = {}; fields.forEach((i) => { body[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
      await act(() => (id ? api('PUT', `/api/staff/filaments/${id}`, body) : api('POST', '/api/staff/filaments', body)), 'Saved');
      extra.filaments = await api('GET', '/api/staff/filaments'); config = null; loadConfig().then(refresh);
    },
    fdel: async () => { if (!confirm('Delete this filament?')) return; await act(() => api('DELETE', `/api/staff/filaments/${id}`), 'Deleted'); extra.filaments = await api('GET', '/api/staff/filaments'); loadConfig().then(refresh); },
  };
  if (handlers[a]) { e.preventDefault(); handlers[a](); }
});
document.addEventListener('change', (e) => {
  const s = e.target;
  if (s.dataset?.act === 'loaded') act(() => api('POST', `/api/staff/printers/${s.dataset.id}/loaded`, { filamentId: s.value || null }));
  if (s.id === 'filament' || s.id === 'name') { if (typeof updateSend === 'function' && $('#send')) updateSend(); }
});
document.addEventListener('toggle', (e) => {
  const d = e.target; if (d.tagName === 'DETAILS' && d.dataset.pid) { d.open ? openPrinters.add(+d.dataset.pid) : openPrinters.delete(+d.dataset.pid); }
}, true);
document.addEventListener('submit', async (e) => {
  const f = e.target; const kind = f.dataset.form; if (!kind) return;
  e.preventDefault();
  const fd = new FormData(f);
  if (kind === 'printer') {
    const body = Object.fromEntries(fd); body.enabled = f.enabled.checked; body.auto_start = f.auto_start.checked;
    const id = f.dataset.id;
    await act(() => (id ? api('PUT', `/api/staff/printers/${id}`, body) : api('POST', '/api/staff/printers', body)), id ? 'Printer saved' : 'Printer added');
    if (!id) f.reset();
  } else if (kind === 'rules') {
    const body = Object.fromEntries(fd);
    body.allowedMaterials = String(body.allowedMaterials).split(',').map((s) => s.trim()).filter(Boolean);
    ['requirePrusaSlicer', 'allowMulticolor', 'requireEmail'].forEach((k) => { body[k] = f[k].checked; });
    extra.rules = await act(() => api('PUT', '/api/staff/rules', body), 'Rules saved') || extra.rules;
    config = null; loadConfig();
  }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  await loadConfig().catch(() => {});
  me = (await api('GET', '/api/staff/me').catch(() => ({}))).staff || null;
  connect();
  render();
})();
