'use strict';

const LEVEL_TEXT = {
  advanced: 'زۆر باش — ئاستێ پێشکەفتی',
  great: 'زۆر باش',
  good: 'باش',
  mid: 'ناوەند',
  low: 'پێویستی ب دووبارە خوێندنەوە هەیە',
};

// All comparisons use integers (correct*100 vs threshold*total) so there is no float rounding risk.
function computeResult(correct, total, passScore) {
  const c100 = correct * 100;
  const score = Math.round((c100 / total) * 100) / 100; // exactly out of 100, 2 decimals
  let key;
  if (c100 >= 90 * total) key = 'advanced';
  else if (c100 >= 80 * total) key = 'great';
  else if (c100 >= 70 * total) key = 'good';
  else if (c100 >= 60 * total) key = 'mid';
  else key = 'low';
  const passed = c100 >= passScore * total;
  const tier = passed && c100 >= 70 * total ? 'congrats' : passed ? 'ok' : 'retry';
  return {
    correct,
    wrong: total - correct,
    score,
    percentage: score,
    levelKey: key,
    level: LEVEL_TEXT[key],
    passed,
    tier,
  };
}

module.exports = { computeResult, LEVEL_TEXT };
