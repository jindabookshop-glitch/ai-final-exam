'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { loadConfig } = require('../server/config');
const { createApp } = require('../server/index');
const { QUESTIONS, getQuestion } = require('../server/questions');
const { computeResult } = require('../server/levels');
const { verifyInitData, verifyLoginWidget } = require('../server/telegram');

const BOT = '123456:TEST-TOKEN';
const cfg = loadConfig({ DEV_MODE: 'true', DB_PATH: ':memory:', BOT_TOKEN: BOT, ADMIN_PASSWORD: 'teacher-pass-1', SESSION_SECRET: 'x'.repeat(40) });

let ctx, base;
test.before(async () => {
  ctx = createApp(cfg);
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
});
test.after(() => ctx.close());

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}
async function login(id) { return (await call('/api/auth/dev', { method: 'POST', body: { id } })).data.token; }

// Simulates a student: finds the displayed option whose text is (or is not) the correct one.
function pick(question, wantCorrect) {
  const q = getQuestion(question.id);
  const correctText = q.options[q.answer];
  const idx = question.options.findIndex((t) => (t === correctText) === wantCorrect);
  assert.ok(idx >= 0);
  return idx;
}
async function playAll(token, nCorrect) {
  let s = (await call('/api/exam/state', { token })).data;
  for (let i = 0; i < 30; i++) {
    const r = await call('/api/exam/answer', { method: 'POST', token, body: { qid: s.question.id, choice: pick(s.question, i < nCorrect) } });
    assert.equal(r.status, 200);
    s = r.data;
  }
  return s;
}

test('question bank is valid: 30 questions, 4 distinct options, one key each, 10/10/10 by level', () => {
  assert.equal(QUESTIONS.length, 30);
  assert.equal(new Set(QUESTIONS.map((q) => q.id)).size, 30);
  for (const q of QUESTIONS) {
    assert.equal(q.options.length, 4, `Q${q.id}`);
    assert.equal(new Set(q.options).size, 4, `Q${q.id} duplicate options`);
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4);
  }
  for (const lv of ['easy', 'medium', 'hard']) assert.equal(QUESTIONS.filter((q) => q.level === lv).length, 10);
});

test('grading + levels at every boundary (integer maths, out of 100)', () => {
  const lv = (c) => computeResult(c, 30, 60);
  assert.equal(lv(30).score, 100);
  assert.equal(lv(27).level, 'زۆر باش — ئاستێ پێشکەفتی'); // exactly 90
  assert.equal(lv(26).level, 'زۆر باش');                    // 86.67
  assert.equal(lv(26).score, 86.67);
  assert.equal(lv(24).level, 'زۆر باش');                    // exactly 80
  assert.equal(lv(23).level, 'باش');                         // 76.67
  assert.equal(lv(21).level, 'باش');                         // exactly 70
  assert.equal(lv(20).level, 'ناوەند');                      // 66.67
  assert.equal(lv(18).level, 'ناوەند');                      // exactly 60
  assert.equal(lv(17).level, 'پێویستی ب دووبارە خوێندنەوە هەیە'); // 56.67
  assert.equal(lv(18).passed, true);
  assert.equal(lv(17).passed, false);
  assert.equal(lv(21).tier, 'congrats');
  assert.equal(lv(19).tier, 'ok');
  assert.equal(lv(0).tier, 'retry');
  assert.equal(lv(26).correct + lv(26).wrong, 30);
});

test('Telegram signature checks: valid, tampered, expired, wrong bot', () => {
  const now = Math.floor(Date.now() / 1000);
  const make = (token, authDate, user) => {
    const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAA', user: JSON.stringify(user) });
    const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return p.toString();
  };
  const good = make(BOT, now, { id: 777, first_name: 'Test' });
  assert.equal(verifyInitData(good, BOT, 86400).ok, true);
  assert.equal(verifyInitData(good, BOT, 86400).user.id, 777);
  assert.equal(verifyInitData(good.replace('777', '778'), BOT, 86400).ok, false);          // tampered id
  assert.equal(verifyInitData(make(BOT, now - 999999, { id: 1 }), BOT, 86400).ok, false);   // expired
  assert.equal(verifyInitData(good, 'other:token', 86400).ok, false);                       // other bot
  assert.equal(verifyInitData('', BOT, 86400).ok, false);

  // Login Widget
  const w = { id: 555, first_name: 'W', auth_date: now };
  const dcs = Object.keys(w).sort().map((k) => `${k}=${w[k]}`).join('\n');
  const hash = crypto.createHmac('sha256', crypto.createHash('sha256').update(BOT).digest()).update(dcs).digest('hex');
  assert.equal(verifyLoginWidget({ ...w, hash }, BOT, 86400).ok, true);
  assert.equal(verifyLoginWidget({ ...w, id: 556, hash }, BOT, 86400).ok, false);
});

test('forged Telegram auth is rejected by the API; protected routes need a token', async () => {
  assert.equal((await call('/api/auth/telegram', { method: 'POST', body: { initData: 'user=%7B%22id%22%3A1%7D&hash=00' } })).status, 401);
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/me', { token: 'abc.def' })).status, 401);
  assert.equal((await call('/api/exam/state', { token: 'abc' })).status, 401);
});

test('perfect run: random order keeps answers correct, score 100, COMPLETED, no key leaks', async () => {
  const t = await login(1001);
  assert.equal((await call('/api/me', { token: t })).data.status, 'NEW');
  const start = await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'ئەحمەد' } });
  assert.equal(start.status, 200);
  assert.equal(start.data.total, 30);
  assert.ok(!/"answer"|correct|"key"/i.test(start.text), 'state must not leak the answer key');
  assert.equal(start.data.question.options.length, 4);

  // refresh = same question, same option order (no re-roll)
  const again = (await call('/api/exam/state', { token: t })).data;
  assert.deepEqual(again.question, start.data.question);

  const last = await playAll(t, 30);
  assert.equal(last.allAnswered, true);
  assert.equal(last.question, null);
  const done = await call('/api/exam/submit', { method: 'POST', token: t });
  assert.equal(done.data.status, 'COMPLETED');
  assert.equal(done.data.result.score, 100);
  assert.equal(done.data.result.correct, 30);
  assert.equal(done.data.result.wrong, 0);
  assert.equal(done.data.result.name, 'ئەحمەد');
  assert.equal(done.data.result.tier, 'congrats');
  const row = ctx.exam.getRow('1001');
  assert.equal(row.status, 'COMPLETED');
});

test('levels easy -> medium -> hard are preserved while order is random per user', async () => {
  const orders = [];
  for (const id of [2001, 2002, 2003]) {
    const t = await login(id);
    await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'Student ' + id } });
    const order = JSON.parse(ctx.exam.getRow(String(id)).question_order);
    const levels = order.map((qid) => getQuestion(qid).level);
    assert.deepEqual(levels, [...Array(10).fill('easy'), ...Array(10).fill('medium'), ...Array(10).fill('hard')]);
    orders.push(order.join(','));
  }
  assert.ok(new Set(orders).size > 1, 'orders should differ between users');
});

test('one attempt per Telegram ID: restart, new name, re-login and refresh never give a new exam', async () => {
  const t = await login(1001); // finished in the previous test
  const me = (await call('/api/me', { token: t })).data;
  assert.equal(me.status, 'COMPLETED');
  const r = await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'ناڤەکێ دی' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'ALREADY_DONE');
  assert.equal(r.data.state.result.name, 'ئەحمەد'); // name never changes
  const t2 = await login(1001); // fresh session, same Telegram ID
  assert.equal((await call('/api/exam/start', { method: 'POST', token: t2, body: { name: 'X Y' } })).status, 409);
  const s = await call('/api/exam/state', { token: t2 });
  assert.equal(s.data.status, 'COMPLETED');
  const a = await call('/api/exam/answer', { method: 'POST', token: t2, body: { qid: 1, choice: 0 } });
  assert.equal(a.status, 409);
});

test('answers are write-once and strictly sequential', async () => {
  const t = await login(3001);
  const s = (await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'Seq Test' } })).data;
  const q1 = s.question;
  // skipping ahead is rejected
  const other = QUESTIONS.find((q) => q.id !== q1.id).id;
  assert.equal((await call('/api/exam/answer', { method: 'POST', token: t, body: { qid: other, choice: 0 } })).status, 409);
  const ok = await call('/api/exam/answer', { method: 'POST', token: t, body: { qid: q1.id, choice: 0 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.answered, 1);
  // changing the answer to Q1 is rejected and nothing changes
  const redo = await call('/api/exam/answer', { method: 'POST', token: t, body: { qid: q1.id, choice: 1 } });
  assert.equal(redo.status, 409);
  assert.equal(redo.data.code, 'OUT_OF_SEQUENCE');
  assert.equal(ctx.exam.getRow('3001').answers.split(',').length, 1);
  // bad input
  assert.equal((await call('/api/exam/answer', { method: 'POST', token: t, body: { qid: ok.data.question.id, choice: 9 } })).status, 400);
  // cannot submit early
  assert.equal((await call('/api/exam/submit', { method: 'POST', token: t })).status, 400);
});

test('mixed result: 26 correct = 86.67 / 100, level "زۆر باش"', async () => {
  const t = await login(4001);
  await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'Mixed' } });
  await playAll(t, 26);
  const r = (await call('/api/exam/submit', { method: 'POST', token: t })).data.result;
  assert.equal(r.correct, 26);
  assert.equal(r.wrong, 4);
  assert.equal(r.score, 86.67);
  assert.equal(r.level, 'زۆر باش');
  assert.equal(r.passed, true);
});

test('all wrong = 0 and "retry" tier', async () => {
  const t = await login(4002);
  await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'Zero' } });
  await playAll(t, 0);
  const r = (await call('/api/exam/submit', { method: 'POST', token: t })).data.result;
  assert.equal(r.score, 0);
  assert.equal(r.tier, 'retry');
  assert.equal(r.passed, false);
});

test('timer: when time is up the server auto-submits (unanswered = wrong), even if the tab was closed', async () => {
  const t = await login(5001);
  const s = (await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'Late' } })).data;
  for (let i = 0; i < 5; i++) {
    const cur = (await call('/api/exam/state', { token: t })).data.question;
    await call('/api/exam/answer', { method: 'POST', token: t, body: { qid: cur.id, choice: pick(cur, true) } });
  }
  assert.ok(s.remainingSec > 1790 && s.remainingSec <= 1800);
  ctx.db.prepare('UPDATE attempts SET deadline=? WHERE telegram_id=?').run(Date.now() - 1000, '5001');
  const late = await call('/api/exam/answer', { method: 'POST', token: t, body: { qid: 1, choice: 0 } });
  assert.equal(late.status, 409);
  assert.equal(late.data.state.status, 'COMPLETED');
  assert.equal(late.data.state.result.correct, 5);
  assert.equal(late.data.state.result.wrong, 25);
  assert.equal(late.data.state.result.autoSubmitted, true);

  // sweeper path (nobody opens the page again)
  const t2 = await login(5002);
  await call('/api/exam/start', { method: 'POST', token: t2, body: { name: 'Gone' } });
  ctx.db.prepare('UPDATE attempts SET deadline=? WHERE telegram_id=?').run(Date.now() - 1, '5002');
  assert.equal(ctx.exam.sweepExpired(), 1);
  assert.equal(ctx.exam.getRow('5002').status, 'COMPLETED');
  assert.equal(ctx.exam.getRow('5002').score, 0);
});

test('database refuses to edit a completed result (immutable trigger)', () => {
  assert.throws(() => ctx.db.prepare("UPDATE attempts SET score=100 WHERE telegram_id='4002'").run(), /immutable/);
  assert.throws(() => ctx.db.prepare("UPDATE attempts SET name='Hacker' WHERE telegram_id='4002'").run(), /immutable/);
  assert.doesNotThrow(() => ctx.db.prepare("UPDATE attempts SET sheets_synced=0 WHERE telegram_id='4002'").run());
});

test('name validation and the name is locked by the first start', async () => {
  const t = await login(6001);
  assert.equal((await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'A' } })).status, 400);
  assert.equal((await call('/api/exam/start', { method: 'POST', token: t, body: {} })).status, 400);
  const ok = await call('/api/exam/start', { method: 'POST', token: t, body: { name: '  Safar   Ayoub ' } });
  assert.equal(ok.data.name, 'Safar Ayoub');
  const second = await call('/api/exam/start', { method: 'POST', token: t, body: { name: 'Different Name' } });
  assert.equal(second.data.name, 'Safar Ayoub'); // resumes, does not rename or restart
});

test('admin panel: login, stats, list, CSV (formula-safe), technical reset audited, scores not editable', async () => {
  assert.equal((await call('/api/admin/stats')).status, 401);
  assert.equal((await call('/api/admin/stats', { token: await login(1) })).status, 401); // a student token is not an admin token
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const a = (await call('/api/admin/login', { method: 'POST', body: { password: 'teacher-pass-1' } })).data.token;

  const st = (await call('/api/admin/stats', { token: a })).data;
  assert.ok(st.completed >= 5);
  assert.equal(st.highest, 100);
  assert.equal(st.lowest, 0);
  assert.ok(st.average > 0 && st.average < 100);
  assert.ok(st.participants >= st.started);
  const list = (await call('/api/admin/attempts', { token: a })).data.rows;
  assert.ok(list.find((r) => r.telegramId === '1001' && r.score === 100));

  // CSV injection guard
  const t = await login(7001);
  await call('/api/exam/start', { method: 'POST', token: t, body: { name: '=HYPERLINK("http://evil")' } });
  const csv = (await call('/api/admin/export.csv', { token: a })).text;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));

  // no endpoint exists to edit a score
  assert.equal((await call('/api/admin/set-score', { method: 'POST', token: a, body: { telegramId: '1001', score: 5 } })).status, 404);

  // technical reset needs reason + typed confirmation, and is logged
  assert.equal((await call('/api/admin/technical-reset', { method: 'POST', token: a, body: { telegramId: '5001', reason: 'x', confirm: '5001' } })).status, 400);
  assert.equal((await call('/api/admin/technical-reset', { method: 'POST', token: a, body: { telegramId: '5001', reason: 'Phone crashed at start', confirm: '9999' } })).status, 400);
  assert.equal((await call('/api/admin/technical-reset', { method: 'POST', token: a, body: { telegramId: '5001', reason: 'Phone crashed at start', confirm: '5001' } })).status, 200);
  const audit = (await call('/api/admin/audit', { token: a })).data.rows;
  assert.equal(audit[0].action, 'TECHNICAL_RESET');
  assert.equal(audit[0].telegramId, '5001');
  // that student can now sit it again; everyone else stays locked
  const t5 = await login(5001);
  assert.equal((await call('/api/exam/start', { method: 'POST', token: t5, body: { name: 'Late Again' } })).status, 200);
  assert.equal((await call('/api/exam/start', { method: 'POST', token: await login(1001), body: { name: 'Zed' } })).status, 409);
  // guard trigger still in place after the reset
  assert.throws(() => ctx.db.prepare("UPDATE attempts SET score=100 WHERE telegram_id='4002'").run(), /immutable/);
});

test('static files: pages served, no server source or key bank exposed, security headers set', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const html = await home.text();
  assert.ok(!html.includes('answer'));
  for (const p of ['/server/questions.js', '/questions.js', '/../server/questions.js', '/..%2fserver%2fquestions.js', '/.env', '/data/exam.db', '/package.json']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
  for (const f of ['/app.js', '/i18n.js', '/style.css', '/admin']) {
    const r = await fetch(base + f);
    assert.equal(r.status, 200, f);
    const body = await r.text();
    assert.ok(!body.includes('correctAnswer'), f);
  }
  const bundle = await (await fetch(base + '/app.js')).text() + await (await fetch(base + '/i18n.js')).text();
  // none of the correct option texts should be sent to the browser in any static asset
  for (const q of QUESTIONS) {
    if (q.options[q.answer].length < 15) continue; // short brand names (Google, CapCut...) legitimately appear in UI text
    assert.ok(!bundle.includes(q.options[q.answer]), `Q${q.id} answer text found in static assets`);
  }
  for (const q of QUESTIONS) assert.ok(!bundle.includes(q.q), `Q${q.id} question text should only come from the API`);
});
