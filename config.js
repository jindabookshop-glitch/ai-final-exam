'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader (no dependencies). Real environment variables always win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const devMode = env.DEV_MODE === 'true' && !isProd; // dev login can never be on in production
  const cfg = {
    isProd,
    devMode,
    port: num(env.PORT, 3000),
    botToken: env.BOT_TOKEN || '',
    botUsername: (env.BOT_USERNAME || '').replace(/^@/, ''),
    sessionSecret: env.SESSION_SECRET || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'exam.db'),
    durationMin: num(env.EXAM_DURATION_MIN, 30),
    passScore: num(env.PASS_SCORE, 60),
    timezone: env.TIMEZONE || 'Asia/Baghdad',
    trustProxy: env.TRUST_PROXY === 'true',
    authMaxAgeSec: num(env.TELEGRAM_AUTH_MAX_AGE_SEC, 86400),
    sessionTtlSec: 6 * 3600,
    adminTtlSec: 4 * 3600,
    sheets: {
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
      key: (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      id: env.GOOGLE_SHEET_ID || '',
      tab: env.GOOGLE_SHEET_TAB || 'Results',
    },
  };

  const problems = [];
  if (devMode) {
    if (!cfg.sessionSecret) cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    if (!cfg.adminPassword) cfg.adminPassword = 'admin12345';
  } else {
    if (!cfg.botToken) problems.push('BOT_TOKEN is required');
    if (cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
    if (cfg.adminPassword.length < 8) problems.push('ADMIN_PASSWORD must be at least 8 characters');
  }
  if (problems.length) {
    throw new Error('Configuration error:\n - ' + problems.join('\n - ') + '\n(see .env.example)');
  }
  return cfg;
}

module.exports = { loadConfig };
