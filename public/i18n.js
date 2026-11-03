'use strict';
/* Tiny translation layer shared by the main page and the 3D viewer.
   English is the default; French and German are selectable. The choice is kept in localStorage ("mq_lang").
   Dictionaries are flat JSON files in /lang/<code>.json. A key can have a plural pair "<key>.one" / "<key>.other"
   that is chosen from the numeric parameter {n}. Missing keys fall back to English, then to the key itself. */
(function () {
  const LANGS = { en: 'English', fr: 'Français', de: 'Deutsch' };
  const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE' };
  const stored = () => { try { return localStorage.getItem('mq_lang'); } catch { return null; } };
  let lang = LANGS[stored()] ? stored() : 'en';
  let dict = {}, en = {};
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function load(code) {
    const r = await fetch(`/lang/${code}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`language file ${code} missing`);
    return r.json();
  }
  function pick(key, params) {
    for (const d of [dict, en]) {
      if (params && typeof params.n === 'number') {
        const form = new Intl.PluralRules(LOCALES[lang]).select(params.n) === 'one' ? 'one' : 'other';
        if (d[`${key}.${form}`] !== undefined) return d[`${key}.${form}`];
      }
      if (d[key] !== undefined) return d[key];
    }
    return undefined;
  }
  const fill = (tpl, params, escape) => tpl.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = params && params[k];
    if (v === undefined || v === null) return `{${k}}`;
    return escape ? esc(v) : String(v);
  });
  /** Plain text. (Safe to put into html`` templates, which escape it.) */
  function t(key, params) { const tpl = pick(key, params); return tpl === undefined ? key : fill(tpl, params, false); }
  /** Text with markup from the dictionary (<b>, <a>…); the parameters are HTML-escaped. Returns {__raw}. */
  function th(key, params) { const tpl = pick(key, params); return { __raw: tpl === undefined ? esc(key) : fill(tpl, params, true) }; }
  const has = (key) => pick(key) !== undefined;
  /** Label for a value such as a request status: t('status.pending'), or the raw value when there is no translation. */
  const lbl = (prefix, v) => (has(prefix + v) ? t(prefix + v) : String(v ?? ''));

  /** Translate static markup: data-i18n (text), data-i18n-html, data-i18n-title / -aria-label / -placeholder (attributes). */
  function applyStatic(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = th(el.dataset.i18nHtml).__raw; });
    for (const a of ['title', 'aria-label', 'placeholder']) {
      root.querySelectorAll(`[data-i18n-${a}]`).forEach((el) => el.setAttribute(a, t(el.getAttribute(`data-i18n-${a}`))));
    }
    document.documentElement.lang = lang;
    if (document.body.dataset.title) document.title = t(document.body.dataset.title);
  }

  const ready = (async () => {
    [en, dict] = await Promise.all([load('en'), lang === 'en' ? null : load(lang)]);
    if (lang === 'en') dict = en;
    applyStatic();
  })();

  async function setLang(code) {
    if (!LANGS[code]) return;
    try { localStorage.setItem('mq_lang', code); } catch { /* private mode: the choice just isn't remembered */ }
    lang = code;
    dict = code === 'en' ? en : await load(code);
    applyStatic();
    window.dispatchEvent(new CustomEvent('langchange', { detail: code }));
  }
  // another window (e.g. the 3D viewer) switches along when the language is changed in the main window
  addEventListener('storage', (e) => { if (e.key === 'mq_lang' && LANGS[e.newValue] && e.newValue !== lang) setLang(e.newValue); });

  window.I18N = { LANGS, ready, setLang, applyStatic, get lang() { return lang; }, get locale() { return LOCALES[lang]; } };
  window.t = t; window.th = th; window.has = has; window.lbl = lbl;
})();
