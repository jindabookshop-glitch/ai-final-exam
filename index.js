'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createExamService } = require('./exam');
const { createSheets } = require('./sheets');
const { createLimiter } = require('./ratelimit');
const { signToken, verifyToken } = require('./session');
const { verifyInitData, verifyLoginWidget } = require('./telegram');
const { safeEqual, HttpError, fmtDate, fmtTime } = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
const PAGES = { '/': 'index.html', '/admin': 'admin.html' };

function createApp(cfg) {
  const db = openDb(cfg.dbPath);
  const sheets = createSheets({ db, cfg });
  const exam = createExamService({ db, cfg, onFinalized: (row) => sheets.enqueue(row) });

  const authLimit = createLimiter({ windowMs: 60_000, max: 30 });
  const adminLoginLimit = createLimiter({ windowMs: 10 * 60_000, max: 8 });
  const answerLimit = createLimiter({ windowMs: 60_000, max: 90 });
  const generalLimit = createLimiter({ windowMs: 60_000, max: 300 });

  const ipOf = (req) => (cfg.trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' https://telegram.org",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://telegram.org",
      "connect-src 'self'",
      'frame-src https://oauth.telegram.org',
      "frame-ancestors 'self' https://*.telegram.org",
      "base-uri 'none'", "form-action 'self'", "object-src 'none'",
    ].join('; '));
    if (cfg.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  }

  function readJson(req, limit = 20_000) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'TOO_LARGE')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' ? v : {});
        } catch { reject(new HttpError(400, 'BAD_JSON')); }
      });
      req.on('error', reject);
    });
  }

  const bearer = (req) => {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : '';
  };
  function userId(req) {
    const t = verifyToken(bearer(req), cfg.sessionSecret);
    if (!t || t.kind !== 'user' || !/^\d{1,15}$/.test(String(t.tid))) throw new HttpError(401, 'UNAUTHORIZED');
    return String(t.tid);
  }
  function requireAdmin(req) {
    const t = verifyToken(bearer(req), cfg.sessionSecret);
    if (!t || t.kind !== 'admin') throw new HttpError(401, 'UNAUTHORIZED');
  }

  function issueUserToken(user) {
    const t = Math.floor(Date.now() / 1000);
    const tid = String(user.id);
    const ms = Date.now();
    db.prepare(`INSERT INTO participants (telegram_id, username, first_name, first_seen_at, last_seen_at) VALUES (?,?,?,?,?)
                ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_seen_at=excluded.last_seen_at`)
      .run(tid, user.username || null, user.first_name ? String(user.first_name).slice(0, 80) : null, ms, ms);
    return {
      token: signToken({ kind: 'user', tid, exp: t + cfg.sessionTtlSec }, cfg.sessionSecret),
      user: { firstName: user.first_name ? String(user.first_name).slice(0, 80) : '' },
    };
  }

  function cleanName(v) {
    const n = String(v || '').replace(/[\u0000-\u001f\u007f‎‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim();
    if ([...n].length < 2 || [...n].length > 60) throw new HttpError(400, 'BAD_NAME');
    return n;
  }

  // ───────── admin helpers ─────────
  const csvCell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  function adminRows() {
    return db.prepare(`SELECT telegram_id, name, username, status, started_at, finished_at, duration_sec, correct, wrong, score,
                       percentage, level, passed, auto_submitted, sheets_synced FROM attempts
                       ORDER BY COALESCE(finished_at, started_at) DESC`).all()
      .map((r) => ({
        telegramId: r.telegram_id, name: r.name, username: r.username, status: r.status,
        score: r.score, correct: r.correct, wrong: r.wrong, level: r.level, passed: r.passed === null ? null : !!r.passed,
        durationSec: r.duration_sec, autoSubmitted: !!r.auto_submitted, sheetsSynced: !!r.sheets_synced,
        date: fmtDate(r.finished_at || r.started_at, cfg.timezone), time: fmtTime(r.finished_at || r.started_at, cfg.timezone),
      }));
  }
  function adminStats() {
    const one = (sql) => db.prepare(sql).get();
    const agg = one("SELECT COUNT(*) AS n, AVG(score) AS avg, MAX(score) AS max, MIN(score) AS min, SUM(passed) AS passed FROM attempts WHERE status='COMPLETED'");
    return {
      participants: one('SELECT COUNT(*) AS n FROM participants').n,
      started: one('SELECT COUNT(*) AS n FROM attempts').n,
      inProgress: one("SELECT COUNT(*) AS n FROM attempts WHERE status='IN_PROGRESS'").n,
      completed: agg.n,
      passed: agg.passed || 0,
      average: agg.n ? Math.round(agg.avg * 100) / 100 : null,
      highest: agg.n ? agg.max : null,
      lowest: agg.n ? agg.min : null,
      sheets: sheets.status(),
    };
  }

  // ───────── router ─────────
  async function api(req, res, pathname) {
    const key = `${req.method} ${pathname}`;
    const ip = ipOf(req);
    if (!generalLimit(ip)) throw new HttpError(429, 'RATE_LIMIT');

    switch (key) {
      case 'GET /api/config':
        return json(res, 200, { botUsername: cfg.botUsername, devMode: cfg.devMode, durationMin: cfg.durationMin, total: exam.TOTAL });

      case 'POST /api/auth/telegram': {
        if (!authLimit(ip)) throw new HttpError(429, 'RATE_LIMIT');
        const b = await readJson(req);
        const v = verifyInitData(String(b.initData || ''), cfg.botToken, cfg.authMaxAgeSec);
        if (!v.ok) throw new HttpError(401, 'BAD_AUTH');
        return json(res, 200, issueUserToken(v.user));
      }
      case 'POST /api/auth/widget': {
        if (!authLimit(ip)) throw new HttpError(429, 'RATE_LIMIT');
        const b = await readJson(req);
        const v = verifyLoginWidget(b, cfg.botToken, cfg.authMaxAgeSec);
        if (!v.ok) throw new HttpError(401, 'BAD_AUTH');
        return json(res, 200, issueUserToken(v.user));
      }
      case 'POST /api/auth/dev': { // testing only; impossible when NODE_ENV=production
        if (!cfg.devMode) throw new HttpError(404, 'NOT_FOUND');
        const b = await readJson(req);
        const id = Number(b.id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'BAD_ID');
        return json(res, 200, issueUserToken({ id, first_name: 'Dev' }));
      }

      case 'GET /api/me':
        return json(res, 200, exam.me(userId(req)));

      case 'POST /api/exam/start': {
        const tid = userId(req);
        if (!answerLimit(tid)) throw new HttpError(429, 'RATE_LIMIT');
        const b = await readJson(req);
        const existing = exam.getRow(tid);
        const name = existing ? existing.name : cleanName(b.name); // the name is locked by the first start
        const p = db.prepare('SELECT username FROM participants WHERE telegram_id=?').get(tid);
        return json(res, 200, exam.start(tid, name, p && p.username));
      }
      case 'GET /api/exam/state':
        return json(res, 200, exam.state(userId(req)));

      case 'POST /api/exam/answer': {
        const tid = userId(req);
        if (!answerLimit(tid)) throw new HttpError(429, 'RATE_LIMIT');
        const b = await readJson(req);
        if (!Number.isInteger(b.qid) || !Number.isInteger(b.choice) || b.choice < 0 || b.choice > 3) throw new HttpError(400, 'BAD_INPUT');
        return json(res, 200, exam.answer(tid, b.qid, b.choice));
      }
      case 'POST /api/exam/submit':
        return json(res, 200, exam.submit(userId(req)));

      // ───────── admin ─────────
      case 'POST /api/admin/login': {
        if (!adminLoginLimit(ip)) throw new HttpError(429, 'RATE_LIMIT');
        const b = await readJson(req);
        if (!safeEqual(String(b.password || ''), cfg.adminPassword)) throw new HttpError(401, 'BAD_PASSWORD');
        const t = Math.floor(Date.now() / 1000);
        return json(res, 200, { token: signToken({ kind: 'admin', exp: t + cfg.adminTtlSec }, cfg.sessionSecret) });
      }
      case 'GET /api/admin/stats':
        requireAdmin(req);
        return json(res, 200, adminStats());
      case 'GET /api/admin/attempts':
        requireAdmin(req);
        return json(res, 200, { rows: adminRows() });
      case 'GET /api/admin/export.csv': {
        requireAdmin(req);
        const head = ['Telegram ID', 'ناڤ', 'خاڵ', 'راست', 'خەلەت', 'ئاست', 'دۆخ', 'بەروار', 'کات', 'دەم (چرکە)'];
        const lines = [head.map(csvCell).join(',')];
        for (const r of adminRows()) {
          lines.push([r.telegramId, r.name, r.score, r.correct, r.wrong, r.level, r.status, r.date, r.time, r.durationSec].map(csvCell).join(','));
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="results.csv"', 'Cache-Control': 'no-store' });
        return res.end('﻿' + lines.join('\r\n'));
      }
      case 'POST /api/admin/resync-sheets': {
        requireAdmin(req);
        const n = await sheets.syncPending();
        return json(res, 200, { attempted: n, sheets: sheets.status() });
      }
      // Technical-error correction ONLY. Scores can never be edited; an attempt can be deleted (with a reason, fully logged)
      // so a student hit by a genuine technical failure can sit the exam again.
      case 'POST /api/admin/technical-reset': {
        requireAdmin(req);
        const b = await readJson(req);
        const tid = String(b.telegramId || '');
        const reason = String(b.reason || '').trim();
        if (!/^\d{1,15}$/.test(tid) || reason.length < 5 || String(b.confirm) !== tid) throw new HttpError(400, 'BAD_INPUT');
        const row = exam.getRow(tid);
        if (!row) throw new HttpError(404, 'NO_ATTEMPT');
        db.prepare('INSERT INTO audit_log (at, action, telegram_id, detail) VALUES (?,?,?,?)')
          .run(Date.now(), 'TECHNICAL_RESET', tid, JSON.stringify({ reason: reason.slice(0, 300), name: row.name, status: row.status, score: row.score, correct: row.correct }));
        db.exec('DROP TRIGGER IF EXISTS attempts_immutable');
        try { db.prepare('DELETE FROM attempts WHERE telegram_id=?').run(tid); } finally {
          // recreate the guard immediately (same definition as db.js)
          db.exec(`CREATE TRIGGER IF NOT EXISTS attempts_immutable BEFORE UPDATE ON attempts
            WHEN OLD.status = 'COMPLETED' AND (
              NEW.status IS NOT OLD.status OR NEW.name IS NOT OLD.name OR NEW.answers IS NOT OLD.answers OR
              NEW.score IS NOT OLD.score OR NEW.correct IS NOT OLD.correct OR NEW.wrong IS NOT OLD.wrong OR
              NEW.level IS NOT OLD.level OR NEW.passed IS NOT OLD.passed OR NEW.finished_at IS NOT OLD.finished_at)
            BEGIN SELECT RAISE(ABORT, 'completed attempt is immutable'); END;`);
        }
        return json(res, 200, { ok: true });
      }
      case 'GET /api/admin/audit':
        requireAdmin(req);
        return json(res, 200, { rows: db.prepare('SELECT at, action, telegram_id, detail FROM audit_log ORDER BY id DESC LIMIT 100').all()
          .map((r) => ({ date: fmtDate(r.at, cfg.timezone), time: fmtTime(r.at, cfg.timezone), action: r.action, telegramId: r.telegram_id, detail: r.detail })) });

      default:
        throw new HttpError(404, 'NOT_FOUND');
    }
  }

  function serveStatic(req, res, pathname) {
    const file = PAGES[pathname] || pathname.replace(/^\/+/, '');
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(full)]) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { res.writeHead(400); return res.end(); }
    try {
      if (pathname.startsWith('/api/')) return await api(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { code: e.code, ...e.extra });
      console.error('[error]', e);
      return json(res, 500, { code: 'SERVER_ERROR' });
    }
  });

  const timers = [
    setInterval(() => { try { exam.sweepExpired(); } catch (e) { console.error('[sweep]', e.message); } }, 15_000),
    setInterval(() => { sheets.syncPending().catch(() => {}); }, 60_000),
  ];
  timers.forEach((t) => t.unref());

  return { server, db, exam, sheets, close: () => { timers.forEach(clearInterval); server.close(); db.close(); } };
}

if (require.main === module) {
  const cfg = loadConfig();
  const { server, sheets, close } = createApp(cfg);
  server.listen(cfg.port, () => {
    console.log(`Exam server on :${cfg.port}  (${cfg.isProd ? 'production' : 'development'}${cfg.devMode ? ', DEV login ON' : ''})`);
    console.log(`Google Sheets: ${sheets.enabled ? 'enabled' : 'disabled (set GOOGLE_* variables to enable)'}`);
    sheets.syncPending().catch(() => {});
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { close(); process.exit(0); });
}

module.exports = { createApp };
