# تاقیکردنەوەیا کۆتایی کورسا AI — AI Course Final Exam

رێکخراوا گەنجێن بەرهەمدار · مامۆستا: سەفەر ئەیوب
Badini Kurmanji (Arabic script) UI · Telegram login · one attempt per Telegram ID · server-side grading · Google Sheets · teacher panel.

**Zero npm dependencies.** Only Node.js **22.13 or newer** is needed (it uses the built-in SQLite and `fetch`).

```
server/    API, grading, Telegram verification, SQLite, Google Sheets
  questions.js   the 30 questions + answer key (SERVER ONLY, never sent to browsers)
public/    student app (index.html, app.js) and teacher panel (admin.html, admin.js)
           i18n.js = every Badini text on screen (edit wording here)
tests/     automated tests  →  npm test
```

---

## 1. Run the project

```bash
cd ai-final-exam
cp .env.example .env        # then fill it in (steps 2-7)
npm test                    # optional: 16 automated tests
npm start                   # http://localhost:3000
```

Quick local try-out **without Telegram** (never use on a real server):

```bash
DEV_MODE=true npm start     # shows a "DEV login" box; teacher password = admin12345
```
`DEV_MODE` is ignored automatically when `NODE_ENV=production`.

Pages: students `/` · teacher `/admin`.

## 2. Create the Telegram bot

1. In Telegram open **@BotFather** → `/newbot` → choose a name and a username ending with `bot` (e.g. `jinda_ai_exam_bot`).
2. BotFather gives you a token like `123456:ABC...`.

## 3. Put the Bot Token in

In `.env`:
```
BOT_TOKEN=123456:ABC...
BOT_USERNAME=jinda_ai_exam_bot
```
The token is only read from the environment. It is never in the code. If it leaks, revoke it with `/revoke` in BotFather.

Also set a long random secret and the teacher password:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # → SESSION_SECRET
```
```
SESSION_SECRET=<that value>
ADMIN_PASSWORD=<a long password for /admin>
```

## 4. Set up Telegram login

The app supports **two ways**; both give the server a *signed* Telegram User ID (checked with your bot token on the server, so it cannot be faked):

* **A. Inside Telegram (recommended — one tap, no typing):** use the bot's Mini App button (step 9). Telegram hands the app the user's ID automatically.
* **B. In a normal browser:** the page shows the official "Log in with Telegram" button. For it to work:
  BotFather → `/setdomain` → choose your bot → enter your domain (e.g. `exam.example.com`, **HTTPS required**).

## 5. Connect Google Sheets (optional but recommended)

Every finished exam adds one row: `Telegram ID | ناڤ | خاڵ | رێژە | راست | خەلەت | ئاست | دۆخ | بەروار | کات` (header row is created automatically). If Google is unreachable the result is still saved and retried every minute — nothing is lost, and no row is ever duplicated.

1. Create a Google Sheet. Add a tab named `Results` (or set `GOOGLE_SHEET_TAB`).
2. Copy the Sheet ID from the URL: `docs.google.com/spreadsheets/d/<THIS PART>/edit`.

## 6. Set up the Google API

1. <https://console.cloud.google.com> → create a project → **APIs & Services → Library → Google Sheets API → Enable**.
2. **IAM & Admin → Service Accounts → Create** → open it → **Keys → Add key → JSON** (downloads a file).
3. Open the Google Sheet → **Share** → paste the service account's `client_email` → role **Editor**.
4. From the JSON file copy into `.env`:
```
GOOGLE_SERVICE_ACCOUNT_EMAIL=<client_email>
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=<sheet id>
```
Keep the `\n` sequences and the double quotes. Do not commit the JSON file.
The teacher panel shows the Sheets status and has a "re-send" button.

## 7. Database

Nothing to install: SQLite is built into Node. The file is created at `DB_PATH` (default `./data/exam.db`).
**On a server, put it on a persistent disk/volume** and back it up (copy the `.db` file, or the whole `data/` folder).
Rules enforced *inside the database*: one row per Telegram ID, and a `COMPLETED` result cannot be edited (trigger).

## 8. Deploy to a server

**Any Linux VPS (Node 22):**
```bash
git clone <your repo> && cd ai-final-exam
cp .env.example .env && nano .env        # NODE_ENV=production, TRUST_PROXY=true, secrets...
npm start                                 # use pm2 or systemd to keep it running
```
Put it behind HTTPS (Telegram requires it). Example Caddy (automatic HTTPS):
```
exam.example.com {
    reverse_proxy localhost:3000
}
```
**Docker:**
```bash
docker build -t ai-exam .
docker run -d --restart=always -p 3000:3000 --env-file .env -v exam-data:/data ai-exam
```
**Render / Railway / Fly.io:** create a Node web service (or use the Dockerfile), set the variables from `.env.example` in the dashboard, attach a persistent disk/volume, and set `DB_PATH` to a path on that disk. Run **one instance only** (SQLite).

Production start-up refuses to run if `BOT_TOKEN`, `SESSION_SECRET` (≥32 chars) or `ADMIN_PASSWORD` (≥8 chars) is missing.

## 9. Put the exam link inside Telegram

1. BotFather → `/newapp` (or `/mybots` → your bot → **Bot Settings → Menu Button → Configure menu button**) → URL: `https://exam.example.com/` → title e.g. `تاقیکردنەوە`.
2. Students open your bot and tap the menu button — they land directly in the exam, already logged in.
3. Send participants the bot link: `https://t.me/<BOT_USERNAME>` (or a direct Mini App link `https://t.me/<BOT_USERNAME>/<app_short_name>` if you used `/newapp`).
4. Plain browser link `https://exam.example.com/` also works via the Telegram login button (step 4B).

---

## How the rules are enforced

| Rule | Where |
|---|---|
| One attempt per Telegram ID (even with a new name) | `attempts.telegram_id` is the primary key; `/api/exam/start` resumes or refuses, never restarts |
| Name locked after start | taken from the first start only |
| Refresh does not give a new exam | question order, option order and deadline are stored on the server |
| Correct answers never reach the browser | `server/questions.js` is server-only; API sends one question at a time, without the key |
| Random questions/options without breaking the key | answers are stored as original option indexes, mapped back on the server |
| Cannot change an answer / skip ahead | server accepts only the current question, once |
| 30-minute timer | deadline is on the server; expired exams are auto-submitted (also by a background sweeper if the tab is closed) |
| Score cannot be tampered with | graded only on the server; completed rows are immutable |
| Telegram ID cannot be faked | HMAC signature verified with the bot token + freshness check |
| Result stored as `COMPLETED` | `attempts.status` |

Levels: 90–100 `زۆر باش — ئاستێ پێشکەفتی` · 80–89 `زۆر باش` · 70–79 `باش` · 60–69 `ناوەند` · <60 `پێویستی ب دووبارە خوێندنەوە هەیە`. Each question is worth 100÷30; the score is shown with 2 decimals (26 correct = 86.67).

## Teacher panel (`/admin`)

Participants, started/completed/in-progress, average / highest / lowest, searchable list (name, score, level, date, time, status, Telegram ID), CSV export, Sheets status.
**Scores cannot be edited anywhere.** The only correction tool is a separate, clearly marked *technical correction*: it deletes one student's attempt (so they can sit it again after a genuine technical failure). It needs a written reason and retyping the Telegram ID, and is stored in an audit log.

## Environment variables

See `.env.example`. Optional: `EXAM_DURATION_MIN` (30), `PASS_SCORE` (60), `TIMEZONE` (Asia/Baghdad), `PORT` (3000).

## Editing the questions

Edit `server/questions.js` (`answer` = index 0–3 of the correct option in `options`). Keep exactly 30 questions with 4 options each; `npm test` checks this. Do not change questions after students have started.
