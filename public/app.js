'use strict';
// ---------------------------------------------------------------- tiny helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const raw = (s) => ({ __raw: String(s) });
const val = (v) => (v && v.__raw !== undefined ? v.__raw : Array.isArray(v) ? v.map(val).join('') : v === false || v == null ? '' : esc(v));
const html = (s, ...v) => raw(s.reduce((a, x, i) => a + x + (i < v.length ? val(v[i]) : ''), ''));
const root = $('#root');
// ---------------------------------------------------------------- class combobox: one text field + a dropdown with all classes
// A class that is typed and does not exist yet is created when the form is saved.
function comboInit(input) {
  if (!input || input.dataset.comboReady) return;
  input.dataset.comboReady = '1';
  loadConfig().catch(() => {}); // pick up classes created since the page was loaded
  const wrap = document.createElement('div'); wrap.className = 'combo';
  input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'combo-arrow'; btn.tabIndex = -1; btn.setAttribute('aria-label', t('combo.showAll')); btn.textContent = '▾';
  const list = document.createElement('ul'); list.className = 'combo-list'; list.setAttribute('role', 'listbox'); list.hidden = true; list.id = `combo-${Math.random().toString(36).slice(2, 8)}`;
  wrap.append(btn, list);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', list.id);
  let items = [], active = -1;
  const known = () => (config?.classes || []);
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = (v) => { input.value = v; close(); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); };
  const mark = () => items.forEach((li, i) => { li.classList.toggle('on', i === active); li.setAttribute('aria-selected', i === active ? 'true' : 'false'); if (i === active) li.scrollIntoView({ block: 'nearest' }); });
  function open(showAll) {
    const typed = input.value.replace(/\s+/g, ' ').trim(), q = typed.toLowerCase();
    const opts = showAll || !q ? known() : known().filter((c) => c.toLowerCase().includes(q));
    const exists = known().some((c) => c.toLowerCase() === q);
    list.innerHTML = '';
    if (typed && !exists) { const li = document.createElement('li'); li.className = 'new'; li.setAttribute('role', 'option'); li.dataset.v = typed; li.textContent = t('combo.new', { name: typed }); list.appendChild(li); }
    for (const c of opts) { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.dataset.v = c; li.textContent = c; if (c.toLowerCase() === q) li.classList.add('cur'); list.appendChild(li); }
    if (!list.children.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('combo.empty'); list.appendChild(li); }
    items = [...list.querySelectorAll('li[data-v]')]; active = -1; mark();
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
  }
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
  btn.addEventListener('click', () => { if (list.hidden) { input.focus(); open(true); } else close(); });
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-v]'); if (li) { e.preventDefault(); choose(li.dataset.v); } });
  input.addEventListener('input', () => open(false));
  input.addEventListener('focus', () => { if (!input.value) open(true); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(true); else { active = Math.min(items.length - 1, active + 1); mark(); } }
    else if (e.key === 'ArrowUp' && !list.hidden) { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === 'Enter' && !list.hidden && active >= 0) { e.preventDefault(); choose(items[active].dataset.v); }
    else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
  });
}


let formDirty = false; // true while a staff form has unsaved edits: live updates must not redraw (and wipe) it
const mount = (el, tpl) => { el.innerHTML = tpl.__raw; formDirty = false; };
document.addEventListener('input', (e) => { if (e.target.closest?.('form[data-form]') || e.target.dataset?.fil !== undefined) formDirty = true; });
document.addEventListener('change', (e) => { if (e.target.closest?.('form[data-form]') || e.target.dataset?.fil !== undefined) formDirty = true; });

const fmtDur = (s) => {
  if (s == null) return '–';
  if (s < 60) return '< 1 min';
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
};
const fmtG = (g) => (g == null ? '–' : `${Math.round(g)} g`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(I18N.locale, { dateStyle: 'short', timeStyle: 'short' }) : '–');
const swatch = (hex) => html`<span class="sw" style="background:${hex || '#ccc'}"></span>`;
const filLabel = (f) => (f ? html`${swatch(f.colour_hex)}${f.material} ${f.colour_name}` : '–');
const pill = (s) => html`<span class="pill ${s}">${lbl('status.', s)}</span>`;
const bar = (p) => html`<div class="bar"><i style="width:${Math.max(0, Math.min(100, p || 0))}%"></i></div>`;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4500);
}
// server errors carry a stable code (+ params): show them in the selected language, fall back to the English text
function errText(data, status) {
  if (data && data.code && has(`err.${data.code}`)) {
    const p = { ...(data.params || {}) };
    if (p.status) p.status = lbl('status.', p.status);
    if (p.action) p.action = lbl('act.', p.action);
    return t(`err.${data.code}`, p);
  }
  return (data && data.error) || `HTTP ${status}`;
}
function issueText(i) {
  const key = `iss.${i.key || i.code}`;
  return i.params && has(key) ? t(key, i.params) : i.message;
}
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(errText(data, r.status)); e.data = data; e.status = r.status; throw e; }
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
async function loadConfig() {
  config = await api('GET', '/api/config');
  const f = $('#foot');
  if (f) f.innerHTML = `3DPMQ v${esc(config.version)} · AGPL-3.0-or-later` + (config.source_url ? ` · <a href="${esc(config.source_url)}" rel="noopener">${esc(t('foot.source'))}</a>` : '');
}

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
  if (r === 'staff' && (!me || tab === 'people' || formDirty)) return; // login form, people tab and edited forms have nothing live to show
  if (r === 'staff' && a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return; // don't wipe forms being edited
  routes[r]();
}
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- submit page
let analysis = null; // { file, meta, issues, ok }
function issuesHtml(issues) {
  return html`${issues.map((i) => html`<div class="issue ${i.level}">${{ error: '✗ ', warn: '⚠ ', info: 'ℹ ' }[i.level]}${issueText(i)}</div>`)}`;
}
function metaHtml(m) {
  return html`<dl class="kv">
    <dt>${t('meta.slicer')}</dt><dd>${m.generator || t('meta.unknown')}</dd>
    <dt>${t('meta.profile')}</dt><dd>${m.printerModel || '–'}</dd>
    <dt>${t('meta.material')}</dt><dd>${m.filamentTypes.join(' / ') || '–'} ${m.filamentColours.map((c) => swatch(c))}</dd>
    <dt>${t('meta.time')}</dt><dd>${fmtDur(m.seconds)}</dd>
    <dt>${t('meta.filament')}</dt><dd>${fmtG(m.grams)}</dd>
    <dt>${t('meta.layerNozzle')}</dt><dd>${m.layerHeight ?? '–'} mm / ${m.nozzleDiameter ?? '–'} mm</dd>
    <dt>${t('meta.height')}</dt><dd>${m.maxZ ?? '–'} mm</dd>
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
  const name = localStorage.getItem('mq_name') || '', email = localStorage.getItem('mq_email') || '', cls = localStorage.getItem('mq_class') || '';
  mount(root, html`
    <h1>${t('submit.title')}</h1>
    <div class="card">
      <p class="muted small" style="margin-top:0">${th('submit.intro')}
        ${th('submit.limits', { materials: r.allowedMaterials.join(', '), hours: r.maxHours || '∞', grams: r.maxGrams || '∞' })}
        ${config.printer_models.length ? th('submit.printersHere', { models: config.printer_models.join(', ') }) : ''}</p>
      <div class="drop" id="drop">${th('submit.drop')}<input type="file" id="file" accept=".gcode,.bgcode,.gco" hidden></div>
      <div id="result"></div>
    </div>
    <form class="card" id="form">
      <div class="cols2">
        <div><label for="name">${t('form.name')} *</label><input id="name" name="name" required minlength="2" maxlength="80" value="${name}" autocomplete="name"></div>
        <div><label for="email">${t('form.email')} *</label><input id="email" name="email" type="email" required maxlength="120" value="${email}" autocomplete="email"></div>
      </div>
      <div class="cols2">
        <div><label for="class">${t('form.class')} *</label><input id="class" name="class" maxlength="40" value="${cls}" placeholder="${t('form.classPh')}" autocomplete="off"></div>
        <div class="muted small" style="align-self:end;padding-bottom:9px">${t('form.classHint')}</div>
      </div>
      <label for="what">${t('form.what')} *</label>
      <textarea id="what" name="what" required minlength="3" maxlength="500" rows="2"></textarea>
      <label for="use">${t('form.use')} *</label>
      <textarea id="use" name="use" required minlength="3" maxlength="500" rows="2"></textarea>
      <label for="filament">${t('form.filament')} *</label>
      <select id="filament" name="filamentId" required></select>
      <label for="notes">${t('form.notes')}</label>
      <textarea id="notes" name="notes" maxlength="1000"></textarea>
      <div class="row" style="margin-top:14px"><button class="primary" id="send" disabled>${t('form.send')}</button><span class="muted small" id="hint">${t('form.hintFile')}</span></div>
    </form>`);
  fillFilaments();
  comboInit($('#class'));
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
  sel.innerHTML = `<option value="">${esc(t('form.choose'))}</option>` + config.filaments.map((f) =>
    `<option value="${f.id}">${esc(f.material)} – ${esc(f.colour_name)}</option>`).join('');
  if (keep) sel.value = keep;
}
async function analyse(file, keepFilament) {
  const res = $('#result');
  res.innerHTML = `<p class="muted">${esc(t('submit.checking'))}</p>`;
  const fd = new FormData(); fd.append('file', file);
  if (!keepFilament) $('#filament').value = ''; // a new file re-picks the filament from its own G-code
  const fsel = $('#filament').value; if (fsel) fd.append('filamentId', fsel);
  try {
    const r = await api('POST', '/api/validate', fd);
    analysis = { file, ...r };
    if (!keepFilament && r.meta && !fsel) { const f = nearestFilament(r.meta); if (f) $('#filament').value = f.id; if (f) return analyse(file, true); }
    mount(res, html`<h3 style="margin-top:14px">${file.name} <span class="muted small">(${(file.size / 1048576).toFixed(1)} MB)</span></h3>
      <div class="cols2"><div>${r.meta ? metaHtml(r.meta) : ''}</div><div>${issuesHtml(r.issues)}${r.ok ? html`<div class="issue info" style="background:var(--ok-bg);color:var(--ok)">✓ ${t('submit.passed')}</div>` : ''}</div></div>`);
  } catch (e) { analysis = null; res.innerHTML = `<div class="issue error">${esc(e.message)}</div>`; }
  updateSend();
}
function updateSend() {
  const ok = analysis && analysis.ok && $('#filament').value;
  $('#send').disabled = !ok;
  $('#hint').textContent = !analysis ? t('form.hintFile') : !analysis.ok ? t('form.hintFix') : !$('#filament').value ? t('form.hintFilament') : '';
}
async function send(e) {
  e.preventDefault();
  const f = e.target; const fd = new FormData(f); fd.append('file', analysis.file);
  localStorage.setItem('mq_name', f.name.value); localStorage.setItem('mq_email', f.email.value); localStorage.setItem('mq_class', f.elements['class'].value);
  $('#send').disabled = true;
  try {
    const r = await api('POST', '/api/requests', fd);
    remember(r.id, r.cancel_token); loadConfig().catch(() => {});
    toast(t('submit.sent', { id: r.id }));
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
    <td>${pill(r.status)}${r.status === 'approved' && r.queue_position ? html` <span class="muted small">${t('queue.inLine', { n: r.queue_position })}</span>` : ''}
      ${r.status === 'printing' ? html`<div style="min-width:120px">${bar(r.progress)}</div><span class="small muted">${r.printer_name || ''} ${r.progress != null ? Math.round(r.progress) + '%' : ''}</span>` : ''}
      ${r.status === 'rejected' ? html`<div class="small muted">${r.reject_reason}</div>` : ''}
      ${r.error && r.status !== 'done' ? html`<div class="small muted">${r.error}</div>` : ''}</td>
    <td>${my[r.id] && ['pending', 'approved'].includes(r.status) ? html`<button class="sm danger" data-act="cancel" data-id="${r.id}">${t('queue.cancel')}</button>` : ''}</td></tr>`;
  const table = (list) => html`<table><thead><tr><th>#</th><th>${t('queue.who')}</th><th>${t('queue.filament')}</th><th>${t('queue.file')}</th><th>${t('queue.size')}</th><th>${t('queue.status')}</th><th></th></tr></thead><tbody>${list.map(line)}</tbody></table>`;
  mount(root, html`<h1>${t('queue.title')}</h1>
    <div class="card">${open.length ? table(open) : html`<p class="muted">${th('queue.empty')}</p>`}</div>
    ${closed.length ? html`<h2>${t('queue.recent')}</h2><div class="card">${table(closed)}</div>` : ''}`);
}

// ---------------------------------------------------------------- printers page
function printerCard(p, staff) {
  const cur = p.current;
  return html`<div class="card" style="margin:0">
    <div class="row"><h3 style="margin:0">${p.name}</h3><span class="muted small">${p.model}${p.nozzle ? ` · ${p.nozzle} mm` : ''}</span><span class="right">${pill(p.enabled ? p.state : 'DISABLED')}</span></div>
    <div style="margin:10px 0">${p.state === 'PRINTING' || p.state === 'PAUSED' || p.progress ? html`${bar(p.progress)}<div class="small muted">${p.progress != null ? Math.round(p.progress) + '%' : ''} ${p.time_remaining != null ? '· ' + t('printers.left', { time: fmtDur(p.time_remaining) }) : ''}</div>` : ''}</div>
    ${cur ? html`<div class="small">${t('printers.job', { id: cur.request_id })} · <b>${cur.user_name}</b><br><span class="muted">${cur.file_name}</span></div>` : ''}
    <div class="small muted" style="margin-top:8px">${t('printers.nozzle')} ${p.temp_nozzle != null ? Math.round(p.temp_nozzle) + '°C' : '–'} · ${t('printers.bed')} ${p.temp_bed != null ? Math.round(p.temp_bed) + '°C' : '–'}</div>
    <div class="small" style="margin-top:4px">${t('printers.loaded')} ${p.loaded_filament ? filLabel(p.loaded_filament) : html`<span class="muted">${t('printers.notSet')}</span>`}</div>
    ${!p.online && p.error ? html`<div class="small" style="color:var(--err)">${p.error}</div>` : ''}
    ${staff ? html`<div class="row" style="margin-top:10px">
      ${p.bed_clear ? html`<span class="pill approved">${t('printers.bedClearPill')}</span><button class="sm" data-act="bed" data-id="${p.id}" data-v="0">${t('printers.undo')}</button>` : html`<button class="sm ok" data-act="bed" data-id="${p.id}" data-v="1">${t('printers.bedIsClear')}</button>`}
      ${p.job_id != null && p.state === 'PRINTING' ? html`<button class="sm" data-act="pctl" data-id="${p.id}" data-a="pause">${t('printers.pause')}</button>` : ''}
      ${p.state === 'PAUSED' ? html`<button class="sm" data-act="pctl" data-id="${p.id}" data-a="resume">${t('printers.resume')}</button>` : ''}
      ${p.job_id != null && ['PRINTING', 'PAUSED'].includes(p.state) ? html`<button class="sm danger" data-act="pctl" data-id="${p.id}" data-a="stop">${t('printers.stop')}</button>` : ''}</div>` : ''}
  </div>`;
}
function renderPrinters() {
  mount(root, html`<h1>${t('printers.title')}</h1>${state.printers.length ? html`<div class="grid">${state.printers.filter((p) => p.enabled).map((p) => printerCard(p, !!me))}</div>` : html`<p class="muted">${t('printers.none')}</p>`}`);
}

// ---------------------------------------------------------------- staff page
let tab = 'review';
const openPrinters = new Set();
let extra = { rules: null, filaments: null, audit: null };

async function renderStaff() {
  if (me === null) { const r = await api('GET', '/api/staff/me'); me = r.staff; if (me) connect(); }
  if (!me) {
    mount(root, html`<h1>${t('staff.title')}</h1><form class="card" id="login" style="max-width:380px">
      <label for="sn">${t('staff.yourName')}</label><input id="sn" name="name" maxlength="60" value="${localStorage.getItem('mq_staffname') || ''}">
      <label for="sp">${t('staff.password')}</label><input id="sp" name="password" type="password" required>
      <div style="margin-top:14px"><button class="primary">${t('staff.login')}</button></div></form>`);
    $('#login').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      localStorage.setItem('mq_staffname', f.name.value);
      await act(async () => { const r = await api('POST', '/api/staff/login', { name: f.name.value, password: f.password.value }); me = r.name; connect(); renderStaff(); });
    };
    return;
  }
  if (tab === 'people' && !people.list) await loadPeople();
  if (tab === 'rules' && !extra.rules) extra.rules = await api('GET', '/api/staff/rules');
  if (tab === 'filaments' && !extra.filaments) extra.filaments = await api('GET', '/api/staff/filaments');
  if (tab === 'log' && !extra.audit) extra.audit = await api('GET', '/api/staff/audit');
  const pending = state.requests.filter((r) => r.status === 'pending');
  const ready = state.requests.filter((r) => r.status === 'approved');
  const tabs = [['review', t('staff.tab.review', { n: pending.length })], ['ready', t('staff.tab.ready', { n: ready.length })], ['printers', t('staff.tab.printers')], ['people', t('staff.tab.people')], ['filaments', t('staff.tab.filaments')], ['rules', t('staff.tab.rules')], ['log', t('staff.tab.log')]];
  const body = { review: () => staffReview(pending), ready: () => staffReady(ready), printers: staffPrinters, people: staffPeople, filaments: staffFilaments, rules: staffRules, log: staffLog }[tab]();
  mount(root, html`<div class="row"><h1 style="margin:0">${t('staff.title')}</h1><span class="muted small">${t('staff.loggedInAs', { name: me })}</span><button class="sm right" data-act="logout">${t('staff.logout')}</button></div>
    <div class="tabs" style="margin-top:12px">${tabs.map(([k, l]) => html`<button class="${k === tab ? 'active' : ''}" data-act="tab" data-t="${k}">${l}</button>`)}</div>${body}`);
  if (tab === 'people') drawPersonPanel();
}

function reqDetail(r) {
  const m = r.meta;
  return html`<div class="cols2"><div>
      <dl class="kv"><dt>${t('req.from')}</dt><dd><b>${r.user_name}</b> ${r.user_email ? html`· <a href="mailto:${r.user_email}">${r.user_email}</a>` : ''}${r.user_class ? ` · ${t('req.class', { name: r.user_class })}` : ''}</dd>
        <dt>${t('meta.filament')}</dt><dd>${filLabel(r.filament)}</dd><dt>${t('req.submitted')}</dt><dd>${fmtDate(r.created_at)}</dd>
        <dt>${t('req.print')}</dt><dd style="white-space:pre-wrap">${r.print_what || '–'}</dd><dt>${t('req.use')}</dt><dd style="white-space:pre-wrap">${r.print_use || '–'}</dd>
        ${r.notes ? html`<dt>${t('req.notes')}</dt><dd>${r.notes}</dd>` : ''}</dl>${m ? metaHtml(m) : ''}</div>
    <div>${issuesHtml(r.issues || [])}</div></div>`;
}
const isRefused = (r) => r.status === 'rejected' || (r.status === 'cancelled' && !r.started_at);
function refusedSection() {
  const l = state.requests.filter(isRefused);
  if (!l.length) return '';
  return html`<h2 class="row">${t('refused.title', { n: l.length })} <button class="sm danger right" data-act="refclear">${t('refused.clearAll')}</button></h2>
    <div class="card" style="overflow-x:auto"><table><thead><tr><th>#</th><th>${t('queue.who')}</th><th>${t('queue.file')}</th><th>${t('queue.status')}</th><th></th></tr></thead><tbody>
    ${l.map((r) => html`<tr><td>#${r.id}</td><td>${r.user_name}</td><td class="small">${r.file_name}</td>
      <td>${pill(r.status)} <span class="small muted">${r.reject_reason || r.error || ''}</span></td>
      <td><button class="sm" data-act="refdel" data-id="${r.id}">${t('refused.remove')}</button></td></tr>`)}</tbody></table></div>`;
}
function staffReview(list) {
  if (!list.length) return html`<p class="muted">${t('review.none')}</p>${refusedSection()}`;
  return html`${list.map((r) => html`<div class="card"><div class="row"><h3 style="margin:0">#${r.id} · ${r.file_name}</h3><span class="muted small">${fmtG(r.grams)} · ${fmtDur(r.seconds)}</span>
      <span class="right row"><a class="btn sm" href="/preview.html?id=${r.id}" target="_blank" rel="noopener" data-act="preview" data-id="${r.id}" title="${t('review.previewTitle')}">${t('review.preview')}</a>
      <a class="btn sm" href="/api/staff/requests/${r.id}/file">${t('review.download')}</a>
      <button class="sm" data-act="prio" data-id="${r.id}" data-d="1">▲</button><button class="sm" data-act="prio" data-id="${r.id}" data-d="-1">▼</button>
      <button class="sm danger" data-act="reject" data-id="${r.id}">${t('review.reject')}</button><button class="sm primary" data-act="approve" data-id="${r.id}">${t('review.approve')}</button></span></div>
      ${reqDetail(r)}</div>`)}${refusedSection()}`;
}
function staffReady(list) {
  if (!list.length) return html`<p class="muted">${t('ready.none')}</p>`;
  return html`<p class="muted small">${t('ready.help')}</p>
  ${list.map((r) => html`<div class="card"><div class="row"><h3 style="margin:0">#${r.id} · ${r.user_name}</h3><span>${filLabel(r.filament)}</span>
      <span class="muted small">${r.file_name} · ${fmtG(r.grams)} · ${fmtDur(r.seconds)}</span><span class="pill approved">${t('queue.inLine', { n: r.queue_position })}</span>
      <span class="right row"><a class="btn sm" href="/preview.html?id=${r.id}" target="_blank" rel="noopener" data-act="preview" data-id="${r.id}" title="${t('review.previewTitle')}">${t('review.preview')}</a>
      <button class="sm" data-act="prio" data-id="${r.id}" data-d="1">▲</button><button class="sm" data-act="prio" data-id="${r.id}" data-d="-1">▼</button>
      <button class="sm danger" data-act="reject" data-id="${r.id}">${t('review.reject')}</button></span></div>
      ${r.error ? html`<div class="issue error">${r.error}</div>` : ''}
      <div class="small" style="margin-top:6px"><b>${t('req.print')}:</b> ${r.print_what || '–'} · <b>${t('req.use')}:</b> ${r.print_use || '–'}</div>
      <div class="row" style="margin-top:10px">${r.eligible.length
        ? r.eligible.map((p) => html`<button class="primary sm" data-act="start" data-id="${r.id}" data-p="${p.id}" ${p.available ? '' : 'disabled'}>${t('ready.startOn', { name: p.name })}${p.available ? '' : ' ' + t('ready.busy')}</button>`)
        : html`<span class="muted small">${t('ready.noneLoaded')} ${filLabel(r.filament)}</span>
          ${state.printers.filter((p) => p.available).map((p) => html`<button class="sm" data-act="startany" data-id="${r.id}" data-p="${p.id}">${t('ready.startAnyway', { name: p.name })}</button>`)}`}</div></div>`)}`;
}
function staffPrinters() {
  const fils = extra.filaments || [];
  return html`${state.printers.map((p) => html`<div class="card">
    ${printerCard(p, true)}
    <div class="row" style="margin-top:10px"><label class="inline">${t('pform.loadedFilament')}
      <select data-act="loaded" data-id="${p.id}" style="width:auto"><option value="">–</option>${(config?.filaments || []).map((f) => html`<option value="${f.id}" ${p.loaded_filament?.id === f.id ? 'selected' : ''}>${f.material} ${f.colour_name}</option>`)}</select></label>
    </div>
    <details data-pid="${p.id}" ${openPrinters.has(p.id) ? 'open' : ''} style="margin-top:10px"><summary>${t('pform.settings')}</summary>${printerForm(p)}</details></div>`)}
  <div class="card"><h3>${t('pform.add')}</h3>${printerForm(null)}</div>`;
}
function printerForm(p) {
  const v = p || { name: '', base_url: 'http://', username: 'maker', storage: 'usb', model: '', nozzle: 0.4, enabled: true, auto_start: false };
  return html`<form data-form="printer" data-id="${p ? p.id : ''}"><div class="cols2">
    <div><label>${t('pform.name')}</label><input name="name" required value="${v.name}"></div>
    <div><label>${t('pform.address')}</label><input name="base_url" required value="${v.base_url}" placeholder="http://192.168.1.50"></div>
    <div><label>${t('pform.username')}</label><input name="username" value="${v.username}"></div>
    <div><label>${t('pform.password')} ${p ? t('pform.keepPassword') : ''}</label><input name="password" type="password" autocomplete="new-password"></div>
    <div><label>${t('pform.model')}</label><input name="model" value="${v.model}" required></div>
    <div><label>${t('pform.nozzle')}</label><input name="nozzle" type="number" step="0.05" value="${v.nozzle ?? ''}"></div>
    <div><label>${t('pform.storage')}</label><input name="storage" value="${v.storage}"></div></div>
    <div class="row" style="margin-top:12px"><label class="inline"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}> ${t('pform.enabled')}</label>
      <label class="inline"><input type="checkbox" name="auto_start" ${v.auto_start ? 'checked' : ''}> ${t('pform.autoStart')}</label></div>
    <div class="row" style="margin-top:12px"><button class="primary sm">${p ? t('common.save') : t('pform.add')}</button><button type="button" class="sm" data-act="ptest">${t('pform.test')}</button>
      ${p ? html`<button type="button" class="sm danger right" data-act="pdel" data-id="${p.id}">${t('common.delete')}</button>` : ''}<span class="small muted" data-role="ptest-out"></span></div></form>`;
}
function staffFilaments() {
  const fl = extra.filaments || [];
  const rowF = (f) => html`<tr><td><input data-fil="${f?.id ?? ''}" data-k="material" value="${f?.material ?? ''}" placeholder="PLA" style="width:90px"></td>
    <td><input data-fil="${f?.id ?? ''}" data-k="colour_name" value="${f?.colour_name ?? ''}" placeholder="${t('fil.colourName')}"></td>
    <td><input type="color" data-fil="${f?.id ?? ''}" data-k="colour_hex" value="${f?.colour_hex ?? '#cccccc'}"></td>
    <td><label class="inline"><input type="checkbox" data-fil="${f?.id ?? ''}" data-k="in_stock" ${!f || f.in_stock ? 'checked' : ''}> ${t('fil.inStock')}</label></td>
    <td>${f ? html`<button class="sm" data-act="fsave" data-id="${f.id}">${t('common.save')}</button> <button class="sm danger" data-act="fdel" data-id="${f.id}">${t('common.delete')}</button>` : html`<button class="sm primary" data-act="fsave" data-id="">${t('common.add')}</button>`}</td></tr>`;
  return html`<p class="muted small">${t('fil.help')}</p>
    <div class="card"><table><thead><tr><th>${t('meta.material')}</th><th>${t('fil.colour')}</th><th></th><th></th><th></th></tr></thead><tbody>${fl.map(rowF)}${rowF(null)}</tbody></table></div>`;
}
function staffRules() {
  const r = extra.rules;
  const num = (k, l, h = '') => html`<div><label>${l}</label><input type="number" min="0" step="any" name="${k}" value="${r[k]}"><div class="small muted">${h}</div></div>`;
  const chk = (k, l) => html`<label class="inline" style="margin-top:8px"><input type="checkbox" name="${k}" ${r[k] ? 'checked' : ''}> ${l}</label><br>`;
  return html`<form class="card" data-form="rules"><div class="cols2">
    <div><label>${t('rules.materials')}</label><input name="allowedMaterials" value="${r.allowedMaterials.join(', ')}"></div>
    ${num('maxHours', t('rules.maxHours'), t('rules.noLimit'))}${num('maxGrams', t('rules.maxGrams'), t('rules.noLimit'))}
    ${num('maxNozzleTemp', t('rules.maxNozzleTemp'))}${num('maxBedTemp', t('rules.maxBedTemp'))}
    ${num('maxActivePerUser', t('rules.maxActive'), t('rules.noLimit'))}${num('monthlyGramQuota', t('rules.quota'), t('rules.noLimit'))}
    ${num('maxFileMB', t('rules.maxFileMB'))}</div>
    ${chk('requirePrusaSlicer', t('rules.onlyPrusa'))}${chk('allowMulticolor', t('rules.multicolor'))}
    <div style="margin-top:14px"><button class="primary">${t('rules.save')}</button></div></form>`;
}
function staffLog() {
  return html`<div class="row"><a class="btn" href="/api/staff/export.csv">${t('log.export')}</a></div>
    <div class="card"><table><thead><tr><th>${t('log.time')}</th><th>${t('queue.who')}</th><th>${t('log.action')}</th><th>${t('log.request')}</th><th>${t('log.detail')}</th></tr></thead><tbody>
    ${(extra.audit || []).map((a) => html`<tr><td class="small">${fmtDate(a.ts)}</td><td>${a.actor}</td><td>${a.action}</td><td>${a.request_id ?? ''}</td><td class="small muted">${a.detail}</td></tr>`)}</tbody></table></div>`;
}


// ---------------------------------------------------------------- people tab
const people = { list: null, stats: null, classes: [], classesOpen: false, q: '', role: '', cls: '', sel: null, detail: null, gen: 0 };
const fmtMass = (g) => (g == null ? '–' : g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : g >= 10 ? `${Math.round(g)} g` : `${(Math.round(g * 10) / 10)} g`);
const roleLabel = (r) => lbl('role.', r);

async function loadPeople() {
  const qs = new URLSearchParams();
  if (people.q) qs.set('q', people.q); if (people.role) qs.set('role', people.role); if (people.cls) qs.set('class', people.cls);
  const [list, stats, classes] = await Promise.all([api('GET', '/api/staff/users?' + qs), api('GET', '/api/staff/stats'), api('GET', '/api/staff/classes')]);
  people.list = list; people.stats = stats; people.classes = classes;
}
function peopleTable() {
  const l = people.list;
  if (!l.length) return html`<p class="muted">${t('people.none')}</p>`;
  return html`<div style="overflow-x:auto"><table><thead><tr><th>${t('people.name')}</th><th>${t('form.email')}</th><th>${t('form.class')}</th><th>${t('people.role')}</th><th>${t('people.prints')}</th><th>${t('people.plastic')}</th><th>${t('meta.time')}</th><th>${t('people.lastPrint')}</th><th></th></tr></thead><tbody>
    ${l.map((u) => html`<tr class="${people.sel === u.id ? 'sel' : ''}"><td><b>${u.name}</b>${u.open_requests ? html` <span class="pill approved">${t('people.open', { n: u.open_requests })}</span>` : ''}</td>
      <td class="small">${u.email || html`<span style="color:var(--warn)">⚠ ${t('people.noEmail')}</span>`}</td>
      <td>${u.class || (u.role !== 'staff' ? html`<span style="color:var(--warn)" title="${t('people.classRequired')}">⚠</span>` : '')}</td><td>${roleLabel(u.role)}</td>
      <td>${u.prints}${u.partial ? html` <span class="muted small">${t('people.stopped', { n: u.partial })}</span>` : ''}</td>
      <td class="small">${u.by_material.length ? u.by_material.map((m) => `${m.material} ${fmtMass(m.grams)}`).join(' · ') : '–'}</td>
      <td>${u.seconds ? fmtDur(u.seconds) : '–'}</td><td class="small">${u.last_print ? fmtDate(u.last_print) : '–'}</td>
      <td><button class="sm" data-act="pedit" data-id="${u.id}">${t('common.edit')}</button></td></tr>`)}</tbody></table></div>`;
}
function staffPeople() {
  const s = people.stats, classes = [...people.classes.map((c) => c.name), ...(s.by_class.some((c) => c.class === '(none)') ? ['(none)'] : [])];
  const mats = s.by_material.map((m) => `${m.material} ${fmtMass(m.grams)}`).join(' · ') || '–';
  const maxG = Math.max(1, ...s.by_month.map((m) => m.grams));
  return html`
    <div class="grid" style="margin-bottom:16px">
      <div class="card" style="margin:0"><div class="muted small">${t('people.card.people')}</div><div style="font-size:24px;font-weight:700">${s.people}</div></div>
      <div class="card" style="margin:0"><div class="muted small">${t('people.card.prints')}</div><div style="font-size:24px;font-weight:700">${s.prints}</div></div>
      <div class="card" style="margin:0"><div class="muted small">${t('people.plastic')}</div><div style="font-size:24px;font-weight:700">${fmtMass(s.grams)}</div><div class="small muted">${mats}</div></div>
      <div class="card" style="margin:0"><div class="muted small">${t('meta.time')}</div><div style="font-size:24px;font-weight:700">${s.seconds ? fmtDur(s.seconds) : '–'}</div></div>
    </div>
    <details class="card"><summary>${t('people.totals')}</summary>
      <div class="cols2"><div><h3>${t('people.perClass')}</h3><table><thead><tr><th>${t('form.class')}</th><th>${t('people.card.people')}</th><th>${t('people.prints')}</th><th>${t('people.plasticShort')}</th><th>${t('people.timeShort')}</th></tr></thead><tbody>
        ${s.by_class.map((c) => html`<tr><td>${c.class}</td><td>${c.people}</td><td>${c.prints}</td><td>${fmtMass(c.grams)}</td><td>${c.seconds ? fmtDur(c.seconds) : '–'}</td></tr>`)}</tbody></table></div>
      <div><h3>${t('people.perMonth')}</h3><table><thead><tr><th>${t('people.month')}</th><th>${t('meta.material')}</th><th>${t('people.prints')}</th><th>${t('people.plasticShort')}</th><th></th></tr></thead><tbody>
        ${s.by_month.map((m) => html`<tr><td>${m.month}</td><td>${m.material}</td><td>${m.prints}</td><td>${fmtMass(m.grams)}</td><td style="width:90px"><div class="bar"><i style="width:${(m.grams / maxG) * 100}%"></i></div></td></tr>`)}</tbody></table></div></div>
      <p class="small muted" style="margin-bottom:0">${t('people.statsNote')}</p>
    </details>
    <details class="card" id="p-classes" ${people.classesOpen ? 'open' : ''}><summary>${t('classes.title', { n: people.classes.length })}</summary>
      <p class="muted small">${t('classes.help')}</p>
      ${people.classes.length ? html`<table style="max-width:560px"><thead><tr><th>${t('form.class')}</th><th>${t('people.card.people')}</th><th></th></tr></thead><tbody>
        ${people.classes.map((c) => html`<tr><td><b>${c.name}</b></td><td>${c.people}</td><td class="row" style="gap:6px">
          <button class="sm" data-act="cren" data-id="${c.id}" data-name="${c.name}">${t('classes.rename')}</button>
          <button class="sm danger" data-act="cdel" data-id="${c.id}" data-name="${c.name}" ${c.people ? html`disabled title="${t('classes.moveFirst')}"` : ''}>${t('common.delete')}</button></td></tr>`)}</tbody></table>` : html`<p class="muted">${t('classes.none')}</p>`}
      <form data-form="class" class="row" style="margin-top:10px"><input name="name" placeholder="${t('classes.newPh')}" maxlength="40" required style="max-width:240px"><button class="sm primary">${t('classes.add')}</button></form>
    </details>
    <div class="row" style="margin-bottom:12px">
      <input id="p-q" placeholder="${t('people.search')}" value="${people.q}" style="flex:1;min-width:200px">
      <select id="p-role" style="width:auto"><option value="">${t('people.allRoles')}</option>${['student', 'staff', 'other'].map((r) => html`<option value="${r}" ${people.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`)}</select>
      <select id="p-class" style="width:auto"><option value="">${t('people.allClasses')}</option>${classes.map((c) => html`<option value="${c}" ${people.cls === c ? 'selected' : ''}>${c === '(none)' ? t('people.noClass') : c}</option>`)}</select>
      <button class="primary" data-act="pnew">${t('people.add')}</button><a class="btn" href="/api/staff/users/export.csv">${t('people.export')}</a>
    </div>
    <div id="p-detail"></div>
    <div class="card" id="p-table">${peopleTable()}</div>`;
}
function personForm(u) {
  const v = u || { name: '', email: '', class: '', role: 'student', notes: '' };
  return html`<form data-form="person" data-id="${u ? u.id : ''}"><div class="cols2">
      <div><label>${t('people.name')}</label><input name="name" required minlength="2" maxlength="80" value="${v.name}"></div>
      <div><label>${t('form.email')}</label><input name="email" type="email" required maxlength="120" value="${v.email}"></div>
      <div><label>${t('people.classReq')}</label><input name="class" maxlength="40" value="${v.class}" placeholder="${t('form.classPh')}" autocomplete="off" data-combo></div>
      <div><label>${t('people.role')}</label><select name="role">${['student', 'staff', 'other'].map((r) => html`<option value="${r}" ${v.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`)}</select></div></div>
    <label>${t('people.notes')}</label><textarea name="notes" maxlength="1000">${v.notes}</textarea>
    <div class="row" style="margin-top:12px"><button class="primary">${u ? t('people.saveChanges') : t('people.add')}</button><button type="button" data-act="pclose">${t('common.close')}</button>
      ${u ? html`<span class="right row"><button type="button" class="danger" data-act="udel" data-mode="anonymize" data-id="${u.id}">${t('people.remove')}</button>
        <button type="button" class="danger" data-act="udel" data-mode="purge" data-id="${u.id}">${t('people.removeAll')}</button></span>` : ''}</div></form>`;
}
function personPanel() {
  const d = people.detail;
  if (!d) return '';
  if (d.adding) return html`<div class="card"><h3>${t('people.add')}</h3>${personForm(null)}</div>`;
  const maxG = Math.max(1, ...d.by_month.map((m) => m.grams));
  const tot = d.totals;
  return html`<div class="card"><h3>${d.user.name} <span class="muted small">· ${roleLabel(d.user.role)}</span></h3>${personForm(d.user)}</div>
    <div class="card"><h3>${t('people.stats')}</h3>
      <p>${th('people.summary', { prints: tot.prints, grams: fmtMass(tot.grams), time: tot.seconds ? fmtDur(tot.seconds) : '–' })}${tot.partial ? ' ' + t('people.summaryPartial', { n: tot.partial }) : ''}</p>
      <div class="cols2"><div><h3>${t('people.perMaterial')}</h3>${d.by_material.length ? html`<table><thead><tr><th>${t('meta.material')}</th><th>${t('people.prints')}</th><th>${t('people.plasticShort')}</th><th>${t('people.timeShort')}</th></tr></thead><tbody>
          ${d.by_material.map((m) => html`<tr><td>${m.material}</td><td>${m.prints}${m.partial ? ` (+${m.partial})` : ''}</td><td>${fmtMass(m.grams)}</td><td>${m.seconds ? fmtDur(m.seconds) : '–'}</td></tr>`)}</tbody></table>` : html`<p class="muted">${t('people.nothingYet')}</p>`}</div>
        <div><h3>${t('people.perMonth')}</h3>${d.by_month.length ? html`<table><thead><tr><th>${t('people.month')}</th><th>${t('meta.material')}</th><th>${t('people.prints')}</th><th>${t('people.plasticShort')}</th><th>${t('people.timeShort')}</th><th></th></tr></thead><tbody>
          ${d.by_month.map((m) => html`<tr><td>${m.month}</td><td>${m.material}</td><td>${m.prints}</td><td>${fmtMass(m.grams)}</td><td>${m.seconds ? fmtDur(m.seconds) : '–'}</td><td style="width:70px"><div class="bar"><i style="width:${(m.grams / maxG) * 100}%"></i></div></td></tr>`)}</tbody></table>` : html`<p class="muted">–</p>`}</div></div>
      <h3 style="margin-top:14px">${t('people.requests')}</h3>${d.requests.length ? html`<div style="overflow-x:auto"><table><thead><tr><th>#</th><th>${t('people.date')}</th><th>${t('queue.file')}</th><th>${t('queue.status')}</th><th>${t('meta.material')}</th><th>${t('people.printed')}</th></tr></thead><tbody>
        ${d.requests.map((r) => html`<tr><td>#${r.id}</td><td class="small">${fmtDate(r.created_at)}</td><td class="small">${r.file_name}</td><td>${pill(r.status)}</td><td>${r.material || '–'}</td>
          <td class="small">${r.printed_grams || r.printed_seconds ? `${fmtMass(r.printed_grams)} · ${r.printed_seconds ? fmtDur(r.printed_seconds) : '–'}` : '–'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">${t('people.noRequests')}</p>`}
    </div>`;
}
function drawPersonPanel() {
  const el = $('#p-detail'); if (!el) return;
  el.innerHTML = personPanel().__raw ?? '';
  el.querySelectorAll('input[data-combo]').forEach((i) => comboInit(i));
  const role = el.querySelector('select[name=role]'), cls = el.querySelector('input[name=class]');
  if (role && cls) { const sync = () => { cls.required = role.value !== 'staff'; }; role.addEventListener('change', sync); sync(); } // only staff members may have no class
}
function drawPeopleTable() { const el = $('#p-table'); if (el) el.innerHTML = peopleTable().__raw; }
async function openPerson(id) {
  if (people.sel === id && people.detail && !people.detail.adding) { $('#p-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; } // already open and up to date: do not redraw it under the user's hands
  people.gen++; // whatever was reloading in the background must not redraw over this
  people.sel = id; people.detail = await api('GET', `/api/staff/users/${id}`);
  drawPersonPanel(); drawPeopleTable();
  $('#p-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
async function reloadPeople(keepOpen = true) {
  const gen = ++people.gen;
  await loadPeople();
  if (keepOpen && people.sel) { try { people.detail = await api('GET', `/api/staff/users/${people.sel}`); } catch { people.sel = null; people.detail = null; } }
  if (gen !== people.gen) return;               // the user opened or closed something meanwhile: this result is out of date
  if (formDirty) { drawPeopleTable(); return; } // an edit is in progress: never redraw the form under the user's hands
  await renderStaff();
}
let pTimer;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'p-q') return;
  clearTimeout(pTimer);
  pTimer = setTimeout(async () => { people.q = e.target.value.trim(); await loadPeople(); drawPeopleTable(); }, 250);
});

// ---------------------------------------------------------------- delegated events
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const id = b.dataset.id, a = b.dataset.act;
  const refresh = () => renderStaff();
  const handlers = {
    cancel: () => act(() => api('POST', `/api/requests/${id}/cancel`, { token: mine()[id] }), t('queue.cancelled')),
    logout: async () => { await api('POST', '/api/staff/logout'); me = null; connect(); renderStaff(); },
    tab: () => { tab = b.dataset.t; extra = { rules: null, filaments: null, audit: null }; people.list = null; people.sel = null; people.detail = null; refresh(); },
    preview: () => { // a window of a quarter of the screen's area: half its width and half its height, centred
      const sw = screen.availWidth, sh = screen.availHeight, w = Math.round(sw / 2), h = Math.round(sh / 2);
      const left = Math.round((screen.availLeft ?? 0) + (sw - w) / 2), top = Math.round((screen.availTop ?? 0) + (sh - h) / 2);
      const win = window.open(`/preview.html?id=${id}`, `3dpmq-preview-${id}`, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
      if (!win) toast(t('review.popupBlocked')); else win.focus();
    },
    refclear: async () => {
      const n = state.requests.filter(isRefused).length;
      if (!confirm(t('refused.confirmClear', { n }))) return;
      const r = await act(() => api('POST', '/api/staff/requests/clear-refused'));
      if (r) toast(t('refused.removed', { n: r.removed }));
    },
    refdel: () => act(() => api('DELETE', `/api/staff/requests/${id}`), t('refused.removedOne', { id })),
    cren: async () => {
      const name = prompt(t('classes.promptRename', { name: b.dataset.name }), b.dataset.name);
      if (name && name.trim() && name.trim() !== b.dataset.name) { const r = await act(() => api('PUT', `/api/staff/classes/${id}`, { name }), t('classes.renamed')); if (r) { await loadConfig(); await reloadPeople(true); } }
    },
    cdel: async () => {
      if (!confirm(t('classes.confirmDelete', { name: b.dataset.name }))) return;
      const r = await act(() => api('DELETE', `/api/staff/classes/${id}`), t('classes.deleted')); if (r) { await loadConfig(); await reloadPeople(true); }
    },
    pnew: () => { people.gen++; people.sel = null; people.detail = { adding: true }; drawPersonPanel(); drawPeopleTable(); $('#p-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); },
    pedit: () => act(() => openPerson(+id)),
    pclose: () => { people.gen++; people.sel = null; people.detail = null; drawPersonPanel(); drawPeopleTable(); },
    udel: async () => {
      const mode = b.dataset.mode, name = people.detail?.user?.name ?? t('people.thisPerson');
      if (!confirm(t(mode === 'purge' ? 'people.confirmPurge' : 'people.confirmRemove', { name }))) return;
      const r = await act(() => api('DELETE', `/api/staff/users/${id}?mode=${mode}`), t('people.removed', { name }));
      if (r) { people.sel = null; people.detail = null; await reloadPeople(false); }
    },
    approve: () => act(() => api('POST', `/api/staff/requests/${id}/approve`), t('review.approved', { id })),
    reject: () => { const reason = prompt(t('review.rejectPrompt')); if (reason) act(() => api('POST', `/api/staff/requests/${id}/reject`, { reason }), t('review.rejected', { id })); },
    prio: () => act(() => api('POST', `/api/staff/requests/${id}/priority`, { delta: +b.dataset.d })),
    start: () => confirm(t('ready.confirmStart')) && act(() => api('POST', `/api/staff/requests/${id}/start`, { printerId: +b.dataset.p }), t('ready.uploading')),
    startany: () => confirm(t('ready.confirmAnyway')) && act(() => api('POST', `/api/staff/requests/${id}/start`, { printerId: +b.dataset.p, ignoreFilament: true }), t('ready.uploading')),
    bed: () => act(() => api('POST', `/api/staff/printers/${id}/bed-clear`, { clear: b.dataset.v === '1' })),
    pctl: () => (b.dataset.a !== 'stop' || confirm(t('printers.confirmStop'))) && act(() => api('POST', `/api/staff/printers/${id}/${b.dataset.a}`)),
    pdel: () => confirm(t('pform.confirmDelete')) && act(() => api('DELETE', `/api/staff/printers/${id}`), t('pform.deleted')),
    ptest: async () => {
      const f = b.closest('form'); const out = f.querySelector('[data-role=ptest-out]'); out.textContent = t('pform.testing');
      const body = Object.fromEntries(new FormData(f)); body.id = f.dataset.id || undefined;
      const r = await api('POST', '/api/staff/printers/test', body).catch((x) => ({ ok: false, error: x.message }));
      out.textContent = r.ok ? t('pform.connected', { state: lbl('status.', r.state) }) : `✗ ${r.error}`;
    },
    fsave: async () => {
      const fields = [...document.querySelectorAll(`[data-fil="${id}"]`)];
      const body = {}; fields.forEach((i) => { body[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
      await act(() => (id ? api('PUT', `/api/staff/filaments/${id}`, body) : api('POST', '/api/staff/filaments', body)), t('common.saved'));
      extra.filaments = await api('GET', '/api/staff/filaments'); config = null; loadConfig().then(refresh);
    },
    fdel: async () => { if (!confirm(t('fil.confirmDelete'))) return; await act(() => api('DELETE', `/api/staff/filaments/${id}`), t('common.deleted')); extra.filaments = await api('GET', '/api/staff/filaments'); loadConfig().then(refresh); },
  };
  if (handlers[a]) { e.preventDefault(); handlers[a](); }
});
document.addEventListener('change', (e) => {
  const s = e.target;
  if (s.dataset?.act === 'loaded') act(() => api('POST', `/api/staff/printers/${s.dataset.id}/loaded`, { filamentId: s.value || null }));
  if (s.id === 'p-role' || s.id === 'p-class') {
    if (s.id === 'p-role') people.role = s.value; else people.cls = s.value;
    loadPeople().then(drawPeopleTable); return;
  }
  if (s.id === 'filament' || s.id === 'name') { if (typeof updateSend === 'function' && $('#send')) updateSend(); }
});
document.addEventListener('toggle', (e) => {
  const d = e.target; if (d.id === 'p-classes') people.classesOpen = d.open;
  if (d.tagName === 'DETAILS' && d.dataset.pid) { d.open ? openPrinters.add(+d.dataset.pid) : openPrinters.delete(+d.dataset.pid); }
}, true);
document.addEventListener('submit', async (e) => {
  const f = e.target; const kind = f.dataset.form; if (!kind) return;
  e.preventDefault();
  const fd = new FormData(f);
  if (kind === 'class') {
    const r = await act(() => api('POST', '/api/staff/classes', Object.fromEntries(fd)), t('classes.added'));
    if (r) { formDirty = false; await loadConfig(); await reloadPeople(true); }
    return;
  }
  if (kind === 'person') {
    const body = Object.fromEntries(fd), id = f.dataset.id;
    const r = await act(() => (id ? api('PUT', `/api/staff/users/${id}`, body) : api('POST', '/api/staff/users', body)), id ? t('common.saved') : t('people.added'));
    if (r) { formDirty = false; if (!id) people.sel = r.id; await loadConfig(); await reloadPeople(true); }
    return;
  }
  if (kind === 'printer') {
    const body = Object.fromEntries(fd); body.enabled = f.enabled.checked; body.auto_start = f.auto_start.checked;
    const id = f.dataset.id;
    await act(() => (id ? api('PUT', `/api/staff/printers/${id}`, body) : api('POST', '/api/staff/printers', body)), id ? t('pform.saved') : t('pform.addedMsg'));
    if (!id) f.reset();
    formDirty = false; renderStaff();
  } else if (kind === 'rules') {
    const body = Object.fromEntries(fd);
    body.allowedMaterials = String(body.allowedMaterials).split(',').map((s) => s.trim()).filter(Boolean);
    ['requirePrusaSlicer', 'allowMulticolor'].forEach((k) => { body[k] = f[k].checked; });
    extra.rules = await act(() => api('PUT', '/api/staff/rules', body), t('rules.saved')) || extra.rules;
    config = null; loadConfig();
  }
});

// ---------------------------------------------------------------- boot
function buildLangSelect() {
  const sel = $('#lang'); if (!sel) return;
  sel.innerHTML = Object.entries(I18N.LANGS).map(([c, n]) => `<option value="${c}" lang="${c}">${esc(n)}</option>`).join('');
  sel.value = I18N.lang;
  sel.onchange = () => I18N.setLang(sel.value);
}
window.addEventListener('langchange', () => { // the user picked another language: redraw everything that is on screen
  const sel = $('#lang'); if (sel) sel.value = I18N.lang;
  if (config) loadConfig().catch(() => {});
  formDirty = false;
  render();
});
(async function boot() {
  await I18N.ready;
  buildLangSelect();
  await loadConfig().catch(() => {});
  me = (await api('GET', '/api/staff/me').catch(() => ({}))).staff || null;
  connect();
  render();
})();
