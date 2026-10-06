'use strict';
const crypto = require('crypto');
const { QUESTIONS, getQuestion } = require('./questions');
const { computeResult } = require('./levels');
const { tx } = require('./db');
const { fmtDate, fmtTime, HttpError } = require('./util');

const TOTAL = QUESTIONS.length;

function shuffle(arr) {
  const r = arr.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// Random order inside each difficulty band (easy -> medium -> hard is kept) + random option order per question.
function createExamPlan() {
  const order = [];
  for (const level of ['easy', 'medium', 'hard']) {
    order.push(...shuffle(QUESTIONS.filter((q) => q.level === level).map((q) => q.id)));
  }
  const optionOrders = {};
  for (const q of QUESTIONS) optionOrders[q.id] = shuffle(q.options.map((_, i) => i));
  return { order, optionOrders };
}

function createExamService({ db, cfg, onFinalized = () => {} }) {
  const now = () => Date.now();
  const getRow = (tid) => db.prepare('SELECT * FROM attempts WHERE telegram_id = ?').get(tid);

  function resultOf(row) {
    return {
      name: row.name,
      total: TOTAL,
      score: row.score,
      percentage: row.percentage,
      correct: row.correct,
      wrong: row.wrong,
      level: row.level,
      passed: !!row.passed,
      tier: computeResult(row.correct, TOTAL, cfg.passScore).tier,
      date: fmtDate(row.finished_at, cfg.timezone),
      time: fmtTime(row.finished_at, cfg.timezone),
      durationSec: row.duration_sec,
      autoSubmitted: !!row.auto_submitted,
    };
  }

  // The browser only ever gets the CURRENT question, with options already shuffled and WITHOUT the answer key.
  function stateOf(row) {
    if (row.status === 'COMPLETED') return { status: 'COMPLETED', name: row.name, result: resultOf(row) };
    const order = JSON.parse(row.question_order);
    const answers = JSON.parse(row.answers);
    const optOrders = JSON.parse(row.option_orders);
    const answered = Object.keys(answers).length;
    let question = null;
    if (answered < TOTAL) {
      const qid = order[answered];
      const q = getQuestion(qid);
      question = { id: qid, number: answered + 1, text: q.q, options: optOrders[qid].map((i) => q.options[i]) };
    }
    return {
      status: 'IN_PROGRESS',
      name: row.name,
      total: TOTAL,
      answered,
      allAnswered: answered === TOTAL,
      remainingSec: Math.max(0, Math.ceil((row.deadline - now()) / 1000)),
      question,
    };
  }

  function finalize(tid, auto) {
    let finalizedNow = false;
    const row = tx(db, () => {
      const r = getRow(tid);
      if (!r || r.status !== 'IN_PROGRESS') return r;
      const answers = JSON.parse(r.answers);
      let correct = 0;
      for (const [qid, picked] of Object.entries(answers)) {
        const q = getQuestion(Number(qid));
        if (q && q.answer === picked) correct++;
      }
      const res = computeResult(correct, TOTAL, cfg.passScore);
      const finished = Math.min(now(), r.deadline);
      db.prepare(`UPDATE attempts SET status='COMPLETED', finished_at=?, duration_sec=?, correct=?, wrong=?, score=?,
                  percentage=?, level=?, passed=?, auto_submitted=? WHERE telegram_id=? AND status='IN_PROGRESS'`)
        .run(finished, Math.round((finished - r.started_at) / 1000), res.correct, res.wrong, res.score,
          res.percentage, res.level, res.passed ? 1 : 0, auto ? 1 : 0, tid);
      finalizedNow = true;
      return getRow(tid);
    });
    if (finalizedNow) {
      try { onFinalized(row); } catch { /* sheets problems must never break grading */ }
    }
    return row;
  }

  // If the clock ran out, finish the attempt on the server (works even if the student closed the tab).
  function fresh(row) {
    if (row && row.status === 'IN_PROGRESS' && now() >= row.deadline) return finalize(row.telegram_id, true);
    return row;
  }

  return {
    TOTAL,
    getRow,

    me(tid) {
      const row = fresh(getRow(tid));
      if (!row) return { status: 'NEW' };
      if (row.status === 'COMPLETED') return { status: 'COMPLETED', name: row.name, result: resultOf(row) };
      return { status: 'IN_PROGRESS', name: row.name };
    },

    start(tid, name, username) {
      const row = tx(db, () => {
        const existing = getRow(tid);
        if (existing) return existing;
        const plan = createExamPlan();
        const t = now();
        db.prepare(`INSERT INTO attempts (telegram_id, name, username, status, started_at, deadline, question_order, option_orders, answers)
                    VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?, '{}')`)
          .run(tid, name, username || null, t, t + cfg.durationMin * 60 * 1000,
            JSON.stringify(plan.order), JSON.stringify(plan.optionOrders));
        return getRow(tid);
      });
      const f = fresh(row);
      if (f.status === 'COMPLETED') throw new HttpError(409, 'ALREADY_DONE', { state: stateOf(f) });
      return stateOf(f);
    },

    state(tid) {
      const row = fresh(getRow(tid));
      if (!row) throw new HttpError(404, 'NO_ATTEMPT');
      return stateOf(row);
    },

    answer(tid, qid, choice) {
      let row = fresh(getRow(tid));
      if (!row) throw new HttpError(404, 'NO_ATTEMPT');
      if (row.status === 'COMPLETED') throw new HttpError(409, 'ALREADY_DONE', { state: stateOf(row) });
      const updated = tx(db, () => {
        const r = getRow(tid);
        const order = JSON.parse(r.question_order);
        const answers = JSON.parse(r.answers);
        const answered = Object.keys(answers).length;
        // Strictly sequential and write-once: only the current question can be answered, and only once.
        if (answered >= TOTAL || order[answered] !== qid) return null;
        const optOrders = JSON.parse(r.option_orders);
        answers[qid] = optOrders[qid][choice]; // map displayed position -> original option index
        db.prepare("UPDATE attempts SET answers=? WHERE telegram_id=? AND status='IN_PROGRESS'").run(JSON.stringify(answers), tid);
        return getRow(tid);
      });
      if (!updated) throw new HttpError(409, 'OUT_OF_SEQUENCE', { state: stateOf(getRow(tid)) });
      return stateOf(updated);
    },

    submit(tid) {
      let row = fresh(getRow(tid));
      if (!row) throw new HttpError(404, 'NO_ATTEMPT');
      if (row.status === 'COMPLETED') return stateOf(row); // idempotent
      const answered = Object.keys(JSON.parse(row.answers)).length;
      if (answered < TOTAL) throw new HttpError(400, 'NOT_FINISHED', { state: stateOf(row) });
      return stateOf(finalize(tid, false));
    },

    // Called by a background timer: finish every attempt whose time is up.
    sweepExpired() {
      const rows = db.prepare("SELECT telegram_id FROM attempts WHERE status='IN_PROGRESS' AND deadline <= ?").all(now());
      for (const r of rows) finalize(r.telegram_id, true);
      return rows.length;
    },
  };
}

module.exports = { createExamService, createExamPlan, TOTAL };
