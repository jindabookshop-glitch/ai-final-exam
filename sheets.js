'use strict';
const crypto = require('crypto');
const { fmtDate, fmtTime } = require('./util');

const HEADER = ['Telegram ID', 'ناڤ', 'خاڵ', 'رێژە', 'راست', 'خەلەت', 'ئاست', 'دۆخ', 'بەروار', 'کات'];

// Google Sheets via a Service Account (no dependencies: JWT signed with Node crypto, fetch from Node 22).
function createSheets({ db, cfg, log = console }) {
  const s = cfg.sheets;
  const enabled = !!(s.email && s.key && s.id);
  let chain = Promise.resolve();
  let token = null;
  let tokenExp = 0;
  let headerDone = false;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60000) return token;
    const iat = Math.floor(Date.now() / 1000);
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b({ alg: 'RS256', typ: 'JWT' })}.${b({
      iss: s.email, scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
    })}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), s.key).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    token = j.access_token;
    tokenExp = Date.now() + j.expires_in * 1000;
    return token;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  const base = () => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(s.id)}/values`;
  const rng = (r) => encodeURIComponent(`'${s.tab}'!${r}`);

  async function ensureHeader() {
    if (headerDone) return;
    const cur = await api('GET', `${base()}/${rng('A1:J1')}`);
    if (!cur.values || !cur.values.length) {
      await api('PUT', `${base()}/${rng('A1:J1')}?valueInputOption=RAW`, { values: [HEADER] });
    }
    headerDone = true;
  }

  function toRow(r) {
    // RAW mode => nothing is interpreted as a formula (protects against names like "=HYPERLINK(...)").
    return [String(r.telegram_id), r.name, r.score, `${r.percentage}%`, r.correct, r.wrong, r.level,
      r.passed ? 'سەرکەفتی' : 'سەرنەکەفتی', fmtDate(r.finished_at, cfg.timezone), fmtTime(r.finished_at, cfg.timezone)];
  }

  async function pushOne(tid) {
    const r = db.prepare('SELECT * FROM attempts WHERE telegram_id=?').get(tid);
    if (!r || r.status !== 'COMPLETED' || r.sheets_synced === 1) return;
    try {
      await ensureHeader();
      await api('POST', `${base()}/${rng('A:J')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [toRow(r)] });
      db.prepare('UPDATE attempts SET sheets_synced=1, sheets_error=NULL WHERE telegram_id=?').run(tid);
    } catch (e) {
      db.prepare('UPDATE attempts SET sheets_error=? WHERE telegram_id=?').run(String(e.message).slice(0, 300), tid);
      log.error('[sheets]', e.message);
    }
  }

  const enqueue = (row) => {
    if (!enabled) return Promise.resolve();
    chain = chain.then(() => pushOne(row.telegram_id)).catch(() => {});
    return chain;
  };

  function syncPending() {
    if (!enabled) return Promise.resolve(0);
    const rows = db.prepare("SELECT telegram_id FROM attempts WHERE status='COMPLETED' AND sheets_synced=0").all();
    for (const r of rows) chain = chain.then(() => pushOne(r.telegram_id)).catch(() => {});
    return chain.then(() => rows.length);
  }

  function status() {
    if (!enabled) return { enabled: false, pending: 0 };
    const pending = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status='COMPLETED' AND sheets_synced=0").get().n;
    const err = db.prepare("SELECT sheets_error FROM attempts WHERE sheets_synced=0 AND sheets_error IS NOT NULL ORDER BY finished_at DESC LIMIT 1").get();
    return { enabled: true, pending, lastError: err ? err.sheets_error : null };
  }

  return { enabled, enqueue, syncPending, status, HEADER };
}

module.exports = { createSheets, HEADER };
