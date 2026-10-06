'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      telegram_id   TEXT PRIMARY KEY,
      username      TEXT,
      first_name    TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      telegram_id    TEXT PRIMARY KEY,               -- one attempt per Telegram ID, enforced by the DB
      name           TEXT NOT NULL,
      username       TEXT,
      status         TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
      started_at     INTEGER NOT NULL,
      deadline       INTEGER NOT NULL,
      question_order TEXT NOT NULL,
      option_orders  TEXT NOT NULL,
      answers        TEXT NOT NULL DEFAULT '{}',
      finished_at    INTEGER,
      duration_sec   INTEGER,
      correct        INTEGER,
      wrong          INTEGER,
      score          REAL,
      percentage     REAL,
      level          TEXT,
      passed         INTEGER,
      auto_submitted INTEGER NOT NULL DEFAULT 0,
      sheets_synced  INTEGER NOT NULL DEFAULT 0,
      sheets_error   TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      action      TEXT NOT NULL,
      telegram_id TEXT,
      detail      TEXT
    );
    -- Defense in depth: once COMPLETED, result fields can never be edited (only the Sheets sync flags can change).
    CREATE TRIGGER IF NOT EXISTS attempts_immutable BEFORE UPDATE ON attempts
    WHEN OLD.status = 'COMPLETED' AND (
      NEW.status IS NOT OLD.status OR NEW.name IS NOT OLD.name OR NEW.answers IS NOT OLD.answers OR
      NEW.score IS NOT OLD.score OR NEW.correct IS NOT OLD.correct OR NEW.wrong IS NOT OLD.wrong OR
      NEW.level IS NOT OLD.level OR NEW.passed IS NOT OLD.passed OR NEW.finished_at IS NOT OLD.finished_at)
    BEGIN SELECT RAISE(ABORT, 'completed attempt is immutable'); END;
  `);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { openDb, tx };
