'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createSheets } = require('../server/sheets');
const { createExamService } = require('../server/exam');
const { getQuestion } = require('../server/questions');

test('Google Sheets: header row once, one appended row per finished exam, retry after failure, formula-safe', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg = loadConfig({
    DEV_MODE: 'true', DB_PATH: ':memory:', TIMEZONE: 'Asia/Baghdad',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'),
    GOOGLE_SHEET_ID: 'SHEET123', GOOGLE_SHEET_TAB: 'Results',
  });
  const db = openDb(':memory:');
  const sheets = createSheets({ db, cfg, log: { error() {} } });
  assert.equal(sheets.enabled, true);
  const exam = createExamService({ db, cfg, onFinalized: (r) => sheets.enqueue(r) });

  const calls = [];
  let failAppend = true;
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      assert.match(String(opts.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
      return ok({ access_token: 'tok', expires_in: 3600 });
    }
    assert.equal(opts.headers.Authorization, 'Bearer tok');
    if (opts.method === 'GET') return ok({});                 // empty sheet => header must be written
    if (opts.method === 'PUT') return ok({});
    if (url.includes(':append')) {
      if (failAppend) return { ok: false, status: 503, text: async () => 'unavailable' };
      return ok({});
    }
    throw new Error('unexpected ' + url);
  };
  try {
    exam.start('42', '=1+1', null);
    let s = exam.state('42');
    for (let i = 0; i < 30; i++) {
      const q = getQuestion(s.question.id);
      s = exam.answer('42', s.question.id, s.question.options.indexOf(q.options[q.answer]));
    }
    exam.submit('42');
    await sheets.syncPending(); // first (failed) push was queued by onFinalized; wait for it
    assert.equal(db.prepare("SELECT sheets_synced FROM attempts WHERE telegram_id='42'").get().sheets_synced, 0);
    assert.match(db.prepare("SELECT sheets_error FROM attempts WHERE telegram_id='42'").get().sheets_error, /503/);

    failAppend = false;
    const flipAt = calls.length;
    await sheets.syncPending(); // retry succeeds
    assert.equal(db.prepare("SELECT sheets_synced FROM attempts WHERE telegram_id='42'").get().sheets_synced, 1);
    await sheets.syncPending(); // no duplicate rows
    const okAppends = calls.slice(flipAt).filter((c) => c.url.includes(':append'));
    assert.equal(okAppends.length, 1, 'exactly one successful append after recovery, never a duplicate');
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, 'header written exactly once');
    const row = JSON.parse(okAppends[0].body).values[0];
    assert.equal(row.length, 10);
    assert.equal(row[0], '42');
    assert.equal(row[1], '=1+1');            // kept as text because valueInputOption=RAW
    assert.match(okAppends[0].url, /valueInputOption=RAW/);
    assert.equal(row[2], 100);
    assert.equal(row[3], '100%');
    assert.equal(row[4], 30);
    assert.equal(row[5], 0);
    assert.equal(row[6], 'زۆر باش — ئاستێ پێشکەفتی');
    assert.equal(row[7], 'سەرکەفتی');
    assert.match(row[8], /^\d{2}\/\d{2}\/\d{4}$/);
    assert.match(row[9], /^\d{2}:\d{2}:\d{2}$/);
    const header = JSON.parse(calls.find((c) => c.method === 'PUT').body).values[0];
    assert.deepEqual(header, ['Telegram ID', 'ناڤ', 'خاڵ', 'رێژە', 'راست', 'خەلەت', 'ئاست', 'دۆخ', 'بەروار', 'کات']);
  } finally {
    global.fetch = realFetch;
  }
});
