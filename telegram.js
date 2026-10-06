'use strict';
const crypto = require('crypto');

function eq(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function validUser(u) {
  return u && Number.isSafeInteger(u.id) && u.id > 0;
}

// Telegram Mini App: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData, botToken, maxAgeSec, nowSec = Math.floor(Date.now() / 1000)) {
  if (!botToken || typeof initData !== 'string' || initData.length > 4096) return { ok: false };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false };
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (!eq(calc, hash)) return { ok: false };
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec || authDate - nowSec > 300) return { ok: false };
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return { ok: false }; }
  if (!validUser(user)) return { ok: false };
  return { ok: true, user };
}

// Telegram Login Widget (for normal browsers): https://core.telegram.org/widgets/login#checking-authorization
function verifyLoginWidget(data, botToken, maxAgeSec, nowSec = Math.floor(Date.now() / 1000)) {
  if (!botToken || !data || typeof data !== 'object') return { ok: false };
  const { hash, ...rest } = data;
  if (typeof hash !== 'string') return { ok: false };
  const dcs = Object.keys(rest).sort().filter((k) => rest[k] !== undefined && rest[k] !== null)
    .map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (!eq(calc, hash)) return { ok: false };
  const authDate = Number(rest.auth_date);
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec || authDate - nowSec > 300) return { ok: false };
  const user = { id: Number(rest.id), first_name: rest.first_name, username: rest.username };
  if (!validUser(user)) return { ok: false };
  return { ok: true, user };
}

module.exports = { verifyInitData, verifyLoginWidget };
