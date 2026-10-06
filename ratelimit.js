'use strict';

// Tiny in-memory fixed-window limiter. Fine for one server process.
function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref();
  return function allow(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      e = { n: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.n += 1;
    return e.n <= max;
  };
}
module.exports = { createLimiter };
