(() => {
  'use strict';
  const A = window.I18N.admin;
  const root = document.getElementById('screen');
  const KEY = 'admin_token';
  let token = sessionStorage.getItem(KEY);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return el;
  }
  async function call(path, { method = 'GET', body, raw } = {}) {
    const res = await fetch(path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { sessionStorage.removeItem(KEY); token = null; showLogin(); throw new Error('auth'); }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.code || 'ERR'), { code: data.code });
    return data;
  }
  const fmt = (n) => (n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2));
  const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

  function showLogin() {
    const input = h('input', { type: 'password', placeholder: A.password, autocomplete: 'current-password' });
    const err = h('div', { class: 'err' });
    const go = async () => {
      try {
        const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = res.status === 429 ? window.I18N.errRate : A.wrongPassword; return; }
        token = d.token; sessionStorage.setItem(KEY, token); load();
      } catch { err.textContent = window.I18N.errNetwork; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    root.replaceChildren(h('section', { class: 'hero' }, h('div', { class: 'emoji' }, '🔐'), h('h1', null, A.title)),
      h('div', { class: 'card' }, h('div', { class: 'field' }, input), err, h('button', { class: 'btn', onclick: go }, A.login)));
  }

  async function load() {
    let stats, rows, audit;
    try { [stats, rows, audit] = await Promise.all([call('/api/admin/stats'), call('/api/admin/attempts'), call('/api/admin/audit')]); } catch { return; }
    rows = rows.rows;

    const stat = (label, v) => h('div', { class: 'stat' }, h('b', null, v), h('small', null, label));
    const tbody = h('tbody');
    const draw = (q) => {
      const s = q.trim().toLowerCase();
      const list = rows.filter((r) => !s || r.name.toLowerCase().includes(s) || r.telegramId.includes(s));
      tbody.replaceChildren(...(list.length ? list.map((r) => h('tr', null,
        h('td', null, r.name), h('td', { class: 'num' }, r.status === 'COMPLETED' ? fmt(r.score) : '—'),
        h('td', null, r.level || '—'), h('td', { class: 'num' }, r.status === 'COMPLETED' ? mmss(r.durationSec) : '—'),
        h('td', { class: 'num' }, r.date), h('td', null, h('span', { class: 'pill ' + (r.status === 'COMPLETED' ? 'ok' : 'run') }, r.status === 'COMPLETED' ? A.done : A.running)),
        h('td', { class: 'num' }, r.telegramId)))
        : [h('tr', null, h('td', { colspan: '7', class: 'center muted' }, A.none))]));
    };
    const search = h('input', { type: 'search', placeholder: A.search });
    search.addEventListener('input', () => draw(search.value));
    draw('');

    const sh = stats.sheets;
    const sheetsLine = !sh.enabled ? A.sheetsOff : sh.pending ? `${A.sheetsPending} ${sh.pending}` : A.sheetsOk;

    // technical correction (separate from grading; scores are never editable)
    const tId = h('input', { type: 'text', inputmode: 'numeric', placeholder: A.techId });
    const tReason = h('input', { type: 'text', placeholder: A.techReason, maxlength: '300' });
    const tConfirm = h('input', { type: 'text', inputmode: 'numeric', placeholder: A.techConfirm });
    const tMsg = h('div', { class: 'err' });
    const tBtn = h('button', { class: 'btn danger small', onclick: async () => {
      if (!window.confirm(A.techConfirmAsk)) return;
      try { await call('/api/admin/technical-reset', { method: 'POST', body: { telegramId: tId.value.trim(), reason: tReason.value, confirm: tConfirm.value.trim() } }); tMsg.textContent = A.techDone; load(); }
      catch (e) { tMsg.textContent = A.error + ' (' + (e.code || '') + ')'; }
    } }, A.techButton);

    root.replaceChildren(
      h('section', { class: 'hero' }, h('div', { class: 'emoji' }, '📋'), h('h1', null, A.title), h('div', { class: 'org' }, window.I18N.org)),
      h('div', { class: 'stats' },
        stat(A.participants, stats.participants), stat(A.started, stats.started), stat(A.completed, stats.completed), stat(A.inProgress, stats.inProgress),
        stat(A.passedCount, stats.passed), stat(A.average, fmt(stats.average)), stat(A.highest, fmt(stats.highest)), stat(A.lowest, fmt(stats.lowest))),
      h('div', { class: 'card' },
        h('h2', null, A.list),
        h('div', { class: 'toolbar' }, search,
          h('button', { class: 'btn small', onclick: load }, A.refresh),
          h('button', { class: 'btn ghost small', onclick: async () => {
            const res = await call('/api/admin/export.csv', { raw: true });
            const url = URL.createObjectURL(await res.blob());
            const a = h('a', { href: url, download: 'results.csv' }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          } }, A.export)),
        h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, [A.name, A.score, A.level, A.duration, A.date, A.status, 'Telegram ID'].map((t) => h('th', null, t)))), tbody))),
      h('div', { class: 'card' }, h('h2', null, A.sheets), h('p', null, sheetsLine), sh.lastError ? h('p', { class: 'muted' }, sh.lastError) : null,
        sh.enabled && sh.pending ? h('button', { class: 'btn small', onclick: async () => { await call('/api/admin/resync-sheets', { method: 'POST' }); load(); } }, A.resync) : null),
      h('div', { class: 'card' }, h('details', { class: 'tech' }, h('summary', null, A.techTitle),
        h('p', { class: 'muted' }, A.techNote),
        h('div', { class: 'field' }, tId), h('div', { class: 'field' }, tReason), h('div', { class: 'field' }, tConfirm), tBtn, tMsg,
        audit.rows.length ? h('div', null, h('h2', null, A.audit), h('div', { class: 'tablewrap' }, h('table', null, h('tbody', null, audit.rows.map((r) => h('tr', null,
          h('td', { class: 'num' }, `${r.date} ${r.time}`), h('td', null, r.action), h('td', { class: 'num' }, r.telegramId), h('td', null, r.detail))))))) : null)),
      h('button', { class: 'btn ghost', onclick: () => { sessionStorage.removeItem(KEY); token = null; showLogin(); } }, A.logout));
  }

  token ? load() : showLogin();
})();
