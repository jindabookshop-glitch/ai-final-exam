(() => {
  'use strict';
  const T = window.I18N;
  const root = document.getElementById('screen');
  const TOKEN_KEY = 'exam_token';
  let token = localStorage.getItem(TOKEN_KEY);
  let cfg = { total: 30 };
  let timerId = null;

  // ───────── helpers (DOM is built with textContent only => no HTML injection) ─────────
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const stopTimer = () => { if (timerId) { clearInterval(timerId); timerId = null; } };
  function show(...nodes) {
    stopTimer();
    root.replaceChildren(...nodes.filter(Boolean));
    window.scrollTo(0, 0);
  }
  function setToken(t) {
    token = t;
    if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
  }
  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw { network: true }; }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw { status: res.status, code: data && data.code, data };
    return data;
  }
  const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const errText = (e) => (e && e.network ? T.errNetwork : e && e.status === 429 ? T.errRate : T.errGeneric);

  function hero() {
    return h('section', { class: 'hero' },
      h('div', { class: 'emoji' }, '🧠'),
      h('h1', null, T.title),
      h('div', { class: 'org' }, T.org),
      h('div', { class: 'teacher' }, T.teacher));
  }
  function showLoading(text) { show(hero(), h('div', { class: 'card center' }, h('div', { class: 'spin' }), h('p', { class: 'muted' }, text || T.loading))); }
  function showError(text, again) {
    show(hero(), h('div', { class: 'card center' }, h('p', null, text), again ? h('button', { class: 'btn', onclick: again }, T.retry) : null));
  }

  // ───────── boot / auth ─────────
  async function boot() {
    showLoading();
    try { cfg = await api('/api/config'); } catch (e) { return showError(errText(e), boot); }
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initData) {
      try { tg.ready(); tg.expand(); } catch { /* ignore */ }
      try {
        const r = await api('/api/auth/telegram', { method: 'POST', body: { initData: tg.initData } });
        setToken(r.token);
        return route();
      } catch (e) { return showError(e.status === 401 ? T.errAuth : errText(e), boot); }
    }
    if (token) {
      try { return await route(); } catch (e) {
        if (e.status !== 401) return showError(errText(e), boot);
        setToken(null);
      }
    }
    showLogin();
  }

  function showLogin() {
    const box = h('div', { class: 'center' });
    const card = h('div', { class: 'card center' }, h('h2', null, T.loginTitle), h('p', { class: 'muted' }, T.loginText), box, h('p', { class: 'muted' }, T.loginHint));
    show(hero(), card);
    if (cfg.botUsername) {
      window.onTelegramAuth = async (user) => {
        showLoading();
        try {
          const r = await api('/api/auth/widget', { method: 'POST', body: user });
          setToken(r.token);
          await route();
        } catch (e) { showError(e.status === 401 ? T.errAuth : errText(e), showLogin); }
      };
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://telegram.org/js/telegram-widget.js?22';
      s.setAttribute('data-telegram-login', cfg.botUsername);
      s.setAttribute('data-size', 'large');
      s.setAttribute('data-radius', '12');
      s.setAttribute('data-onauth', 'onTelegramAuth(user)');
      s.setAttribute('data-request-access', 'write');
      box.append(s);
    }
    if (cfg.devMode) {
      const idInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'DEV: Telegram ID (numbers)' });
      card.append(h('div', { class: 'field' }, idInput,
        h('button', { class: 'btn ghost small', onclick: async () => {
          try { const r = await api('/api/auth/dev', { method: 'POST', body: { id: Number(idInput.value) } }); setToken(r.token); route(); } catch (e) { showError(errText(e), showLogin); }
        } }, 'DEV login')));
    }
  }

  async function route() {
    const me = await api('/api/me');
    if (me.status === 'COMPLETED') return showAlready(me.result);
    return showStart(me);
  }

  // ───────── screens ─────────
  function showStart(me) {
    const inProgress = me.status === 'IN_PROGRESS';
    show(hero(),
      h('div', { class: 'card' }, h('p', null, T.intro)),
      h('div', { class: 'card' }, h('h2', null, T.rulesTitle), h('ul', { class: 'rules' }, T.rules.map((r) => h('li', null, r)))),
      h('button', { class: 'btn', onclick: () => (inProgress ? loadExam() : showName()) }, inProgress ? T.resume : T.start));
  }

  function showName() {
    const input = h('input', { type: 'text', maxlength: '60', placeholder: T.namePlaceholder, autocomplete: 'name', enterkeyhint: 'done' });
    const err = h('div', { class: 'err' });
    const btn = h('button', { class: 'btn' }, T.begin);
    const go = async () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if ([...name].length < 2) { err.textContent = T.nameError; return; }
      btn.disabled = true;
      try { renderState(await api('/api/exam/start', { method: 'POST', body: { name } })); } catch (e) {
        btn.disabled = false;
        if (e.code === 'ALREADY_DONE' && e.data && e.data.state) return renderState(e.data.state);
        err.textContent = e.code === 'BAD_NAME' ? T.nameError : errText(e);
      }
    };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    show(hero(), h('div', { class: 'card' }, h('h2', null, T.nameTitle), h('div', { class: 'field' }, input), h('p', { class: 'muted' }, T.nameHint), err), btn);
    input.focus();
  }

  async function loadExam() {
    showLoading();
    try { renderState(await api('/api/exam/state')); } catch (e) { showError(errText(e), loadExam); }
  }

  function renderState(s) {
    if (s.status === 'COMPLETED') return showResult(s.result);
    if (s.allAnswered) return showConfirm(s);
    return showQuestion(s);
  }

  function examHeader(s, label) {
    const timer = h('span', { class: 'timer' }, mmss(s.remainingSec));
    const fill = h('i');
    const head = h('div', { class: 'exam-head' },
      h('div', { class: 'top' }, h('span', null, label), h('span', null, T.timeLeft + ' ', timer)),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(s.total), 'aria-valuenow': String(s.answered) }, fill));
    requestAnimationFrame(() => { fill.style.width = `${(s.answered / s.total) * 100}%`; });
    return { head, timer };
  }

  function startTimer(s, timerEl) {
    const endsAt = performance.now() + s.remainingSec * 1000;
    const tick = async () => {
      const left = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
      timerEl.textContent = mmss(left);
      timerEl.classList.toggle('low', left <= 300);
      if (left <= 0) {
        stopTimer();
        showLoading(T.sending);
        try { renderState(await api('/api/exam/state')); } catch (e) { showError(errText(e), loadExam); }
      }
    };
    tick();
    timerId = setInterval(tick, 500);
  }

  function showQuestion(s) {
    const q = s.question;
    const { head, timer } = examHeader(s, T.questionOf(q.number, s.total));
    let picked = -1;
    const nextBtn = h('button', { class: 'btn', disabled: true }, q.number === s.total ? T.lastQ : T.nextQ);
    const err = h('div', { class: 'err' });
    const buttons = q.options.map((text, i) => {
      const b = h('button', { class: 'opt', type: 'button', role: 'radio', 'aria-checked': 'false' },
        h('span', { class: 'letter' }, 'ABCD'[i]), h('span', null, text));
      b.addEventListener('click', () => {
        picked = i;
        buttons.forEach((x, j) => { x.classList.toggle('sel', j === i); x.setAttribute('aria-checked', String(j === i)); });
        nextBtn.disabled = false;
      });
      return b;
    });
    nextBtn.addEventListener('click', async () => {
      if (picked < 0) return;
      nextBtn.disabled = true;
      buttons.forEach((b) => { b.disabled = true; });
      try {
        renderState(await api('/api/exam/answer', { method: 'POST', body: { qid: q.id, choice: picked } }));
      } catch (e) {
        if (e.data && e.data.state) return renderState(e.data.state); // already answered / time up: show the real state
        err.textContent = errText(e);
        buttons.forEach((b) => { b.disabled = false; });
        nextBtn.disabled = false;
      }
    });
    show(head, h('div', { class: 'card' }, h('div', { class: 'q-text' }, q.text), buttons), err, nextBtn);
    startTimer(s, timer);
  }

  function showConfirm(s) {
    const { head, timer } = examHeader(s, T.questionOf(s.total, s.total));
    const note = h('p', { class: 'muted', hidden: true }, T.noNote);
    const yes = h('button', { class: 'btn' }, T.yesSend);
    const no = h('button', { class: 'btn ghost' }, T.no);
    const err = h('div', { class: 'err' });
    yes.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      stopTimer();
      showLoading(T.sending);
      try { renderState(await api('/api/exam/submit', { method: 'POST' })); } catch (e) {
        if (e.data && e.data.state) return renderState(e.data.state);
        showError(errText(e), loadExam);
      }
    });
    no.addEventListener('click', () => { note.hidden = false; });
    show(head, h('div', { class: 'card center' }, h('div', { class: 'lock' }, '📝'), h('p', null, T.confirmDone), h('h2', null, T.confirmQ), h('p', { class: 'muted' }, T.confirmWarn), note),
      h('div', { class: 'row' }, yes, no), err);
    startTimer(s, timer);
  }

  function kv(label, value, ltr) { return h('div', { class: 'kv' }, h('b', null, label), h('span', ltr ? { class: 'ltr' } : null, value)); }
  function showResult(r) {
    const msg = r.tier === 'congrats' ? T.msgCongrats : r.tier === 'ok' ? T.msgOk : T.msgRetry;
    show(
      r.autoSubmitted ? h('div', { class: 'notice' }, T.timeUp) : null,
      h('div', { class: 'card result-card' },
        h('h2', null, T.resultTitle),
        h('div', { class: 'big' }, `${num(r.score)} / 100`),
        kv(T.lName, r.name), kv(T.lScore, `${num(r.score)} / 100`, true), kv(T.lPercent, `${num(r.percentage)}%`, true),
        kv(T.lCorrect, r.correct, true), kv(T.lWrong, r.wrong, true), kv(T.lLevel, r.level),
        kv(T.lDate, `${r.date}  ${r.time}`, true), kv(T.lTime, mmss(r.durationSec), true)),
      h('div', { class: `msg ${r.tier}` }, msg),
      h('p', { class: 'muted center mt' }, T.closeNote));
  }

  function showAlready(r) {
    show(hero(), h('div', { class: 'card center' }, h('div', { class: 'lock' }, '🔒'), h('h2', null, T.alreadyDone)),
      h('div', { class: 'card result-card' }, kv(T.lName, r.name), kv(T.lScore, `${num(r.score)} / 100`, true), kv(T.lLevel, r.level), kv(T.lDate, `${r.date}  ${r.time}`, true)));
  }

  boot();
})();
