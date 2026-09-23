// Olaf automation — Playwright + 2FA pause para Translation TMS.
//
// Endpoints
//   GET  /                  → landing HTML (auto-fires /run on load)
//   POST /run               → {ok, runId}   kicks off async run
//   GET  /run/:runId        → {state, ...}  poll for status / result
//   GET  /auth/:runId       → HTML form para meter el código 2FA
//   POST /auth/:runId       → resuelve el promise que Playwright espera
//
// Flujo: si hay sesión guardada (.session/state.json), se intenta ir
// directo al job-board — si la sesión sigue válida, fin del flow.
// Si Translation TMS nos redirige a /login, se hace login completo con
// las credenciales de .env; si pide 2FA pausa y expone /auth/:runId.
// Tras login exitoso la sesión se persiste para evitar futuros 2FA.
// ponytail: sesión en disco bajo .session/, gitignored.

const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3018);
const JOB_BOARD_URL =
  process.env.JOB_BOARD_URL ||
  'https://www.translationtms.com/job-board?locales=&statuses=&projectIds=&jobTab=inProgress&tab=job';
const LOGIN_URL =
  process.env.TRANSLATION_TMS_LOGIN_URL || 'https://www.translationtms.com/login';
const TMS_EMAIL = process.env.TRANSLATION_TMS_EMAIL || '';
const TMS_PASSWORD = process.env.TRANSLATION_TMS_PASSWORD || '';

const RUN_TTL_MS = 30 * 60 * 1000; // limpiar runs tras 30 min
const TWO_FA_TIMEOUT_MS = 5 * 60 * 1000; // esperar 5 min máximo el código

// Sesión persistida (cookies + storage de Translation TMS). Si existe y
// sigue válida, el run la salta entero. Si Translation TMS invalida la
// sesión, redirige a /login y caemos al flow completo con credenciales.
const SESSION_DIR = path.join(__dirname, '.session');
const SESSION_FILE = path.join(SESSION_DIR, 'state.json');

async function loadSession() {
  try {
    return JSON.parse(await fs.promises.readFile(SESSION_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function saveSession(context) {
  try {
    await fs.promises.mkdir(SESSION_DIR, { recursive: true });
    const state = await context.storageState();
    await fs.promises.writeFile(SESSION_FILE, JSON.stringify(state));
  } catch (err) {
    console.warn('[olaf] could not save session:', err.message);
  }
}

async function clearSession() {
  try {
    await fs.promises.unlink(SESSION_FILE);
  } catch (_) {
    // nada que limpiar
  }
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));

// Selectores comunes para inputs 2FA / OTP / MFA. Cubre TOTP estándar
// (Google Authenticator, Authy, 1Password) y WebAuthn-fallback.
// ponytail: lista genérica, refinar si el sitio usa algo raro.
const TWO_FA_SELECTOR =
  'input[name*="otp" i], input[name*="2fa" i], input[name*="totp" i], ' +
  'input[name*="mfa" i], input[name*="code" i][maxlength="6"], ' +
  'input[autocomplete="one-time-code"], ' +
  'input[type="tel"][maxlength="6"], ' +
  'input[inputmode="numeric"][maxlength="6"]';

// registry en memoria
const runs = new Map();

function newRunId() {
  return crypto.randomBytes(6).toString('hex');
}

function snapshot(state) {
  return {
    runId: state.id,
    state: state.state,
    requires2fa: state.twoFactor !== null && state.state === 'awaiting_2fa',
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    error: state.error,
    result: state.result,
  };
}

async function runAutomation(state) {
  state.state = 'logging_in';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const saved = await loadSession();
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/131.0.0.0 Safari/537.36 OlafAutomation/0.1',
      ...(saved && { storageState: saved }),
    });
    const page = await context.newPage();

    // 1. Probar suerte con la sesión guardada: ir directo al job-board.
    //    Si Translation TMS sigue aceptando las cookies, aterrizamos en
    //    la página de ofertas. Si expiraron, nos redirige a /login.
    await page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const onLogin = page.url().includes('/login');

    if (!onLogin) {
      // Sesión válida — saltamos login entero.
      state.state = 'running';
    } else {
      state.state = 'logging_in';

      // 2. Llenar credenciales. Selectores flexibles — el primer match gana.
      const emailInput = page
        .locator('input[type="email"], input[name="email"], input[name="username"]')
        .first();
      const passwordInput = page.locator('input[type="password"]').first();
      await emailInput.fill(TMS_EMAIL);
      await passwordInput.fill(TMS_PASSWORD);

      // 3. Submit.
      const submitButton = page
        .locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")')
        .first();
      await submitButton.click();

      // 4. Carrera: ¿prompt 2FA visible o ya nos redirigió a la app?
      const outcome = await Promise.race([
        page
          .waitForSelector(TWO_FA_SELECTOR, { timeout: 15000, state: 'visible' })
          .then(() => '2fa'),
        page
          .waitForURL(/dashboard|home|jobs|board/i, { timeout: 15000 })
          .then(() => 'logged_in'),
      ]).catch(() => 'unknown');

      if (outcome === '2fa') {
        state.state = 'awaiting_2fa';
        // Averiguar el name/id del input detectado para mostrar al usuario.
        const hint = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.name || el.id || el.placeholder || '' : '';
        }, TWO_FA_SELECTOR);

        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('2FA code not provided within timeout')),
            TWO_FA_TIMEOUT_MS,
          );
          timer.unref();
          state.twoFactor = {
            resolve: (c) => {
              clearTimeout(timer);
              resolve(c);
            },
            reject: (r) => {
              clearTimeout(timer);
              reject(new Error(r));
            },
            hint,
          };
        });

        // 5. Llenar el código y submitear.
        await page.locator(TWO_FA_SELECTOR).first().fill(code);
        await page
          .locator('button[type="submit"], button:has-text("Verify"), button:has-text("Continue")')
          .first()
          .click();
        await page
          .waitForLoadState('domcontentloaded', { timeout: 30000 })
          .catch(() => {});
        try {
          await page.waitForLoadState('networkidle', { timeout: 10000 });
        } catch (_) {
          // muchas páginas tienen tráfico de tracking sin fin.
        }
      }

      // 6. Volver al job-board. Si Translation TMS nos redirige otra vez
      //    a /login, las credenciales estaban mal y no hay nada que hacer.
      state.state = 'running';
      state.twoFactor = null; // ya no aplica
      await page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (page.url().includes('/login')) {
        await clearSession();
        throw new Error('login failed — credentials rejected or 2FA code wrong');
      }
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (_) {}

    state.result = {
      title: ((await page.title()) || '').trim(),
      finalUrl: page.url(),
      heading: await page
        .locator('h1, h2')
        .first()
        .textContent()
        .catch(() => null),
    };
    state.state = 'done';

    // Persistir la sesión para que el siguiente run no tenga que loguear.
    await saveSession(context);
  } finally {
    await browser.close().catch(() => {});
    state.finishedAt = new Date().toISOString();
  }
}

function startRun() {
  const id = newRunId();
  const state = {
    id,
    state: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    twoFactor: null,
    result: null,
    error: null,
  };
  runs.set(id, state);
  setTimeout(() => runs.delete(id), RUN_TTL_MS).unref();

  runAutomation(state).catch((err) => {
    state.error = String((err && err.message) || err);
    state.state = 'failed';
    state.finishedAt = new Date().toISOString();
  });

  return state;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>olaf — translation automation</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    @keyframes olaf-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
    .olaf-dot { animation: olaf-pulse 1.4s ease-in-out infinite; }
    .olaf-dot-2 { animation-delay: 0.2s; }
    .olaf-dot-3 { animation-delay: 0.4s; }

    /* Halo: two radial gradients (hot + cool) panned and pulsed. */
    @keyframes olaf-halo-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes olaf-halo-pulse { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }
    .olaf-halo {
      position: absolute;
      inset: -25%;
      background:
        radial-gradient(closest-side at 28% 32%, rgb(255 153 56 / 0.30), transparent 70%),
        radial-gradient(closest-side at 72% 68%, rgb(142 58 11 / 0.35), transparent 70%),
        radial-gradient(closest-side at 50% 50%, rgb(0 0 0 / 0.85), transparent 50%);
      filter: blur(60px);
      animation: olaf-halo-spin 60s linear infinite, olaf-halo-pulse 8s ease-in-out infinite;
    }
    /* Dark center shadow: simulates the event horizon's pitch-black disk. */
    .olaf-shadow {
      position: absolute;
      left: 50%; top: 50%;
      width: 240px; height: 240px;
      transform: translate(-50%, -50%);
      background: radial-gradient(circle, rgb(0 0 0 / 0.95) 0%, rgb(0 0 0 / 0.6) 50%, transparent 75%);
      border-radius: 9999px;
    }
    /* Starfield: small dots scattered via stacked radial-gradients. */
    .olaf-stars {
      position: absolute; inset: 0;
      background-image:
        radial-gradient(1px 1px at 12% 18%, rgba(255,255,255,0.7), transparent),
        radial-gradient(1px 1px at 27% 41%, rgba(255,255,255,0.5), transparent),
        radial-gradient(1px 1px at 41% 9%, rgba(255,255,255,0.6), transparent),
        radial-gradient(1px 1px at 58% 26%, rgba(255,255,255,0.4), transparent),
        radial-gradient(1px 1px at 73% 12%, rgba(255,255,255,0.7), transparent),
        radial-gradient(1px 1px at 88% 38%, rgba(255,255,255,0.5), transparent),
        radial-gradient(1px 1px at 8% 62%, rgba(255,255,255,0.6), transparent),
        radial-gradient(1px 1px at 22% 78%, rgba(255,255,255,0.4), transparent),
        radial-gradient(1px 1px at 36% 91%, rgba(255,255,255,0.7), transparent),
        radial-gradient(1px 1px at 51% 68%, rgba(255,255,255,0.5), transparent),
        radial-gradient(1px 1px at 66% 84%, rgba(255,255,255,0.6), transparent),
        radial-gradient(1px 1px at 82% 71%, rgba(255,255,255,0.4), transparent),
        radial-gradient(1px 1px at 95% 92%, rgba(255,255,255,0.7), transparent);
      background-size: 100% 100%;
      animation: olaf-halo-pulse 6s ease-in-out infinite;
    }
  </style>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100 antialiased overflow-x-hidden relative">
  <div class="olaf-halo" aria-hidden="true"></div>
  <div class="olaf-stars" aria-hidden="true"></div>

  <main class="relative mx-auto max-w-2xl px-6 py-16 sm:py-24">
      <header class="mb-12">
        <div class="flex items-center gap-3 mb-4">
          <div class="h-10 w-10 rounded-xl bg-white grid place-items-center text-slate-900 font-bold text-lg shadow-sm">o</div>
          <div>
            <h1 class="text-xl font-semibold tracking-tight text-white">olaf</h1>
            <p class="text-xs text-slate-400">Translation TMS automation</p>
          </div>
          <span class="ml-auto inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur px-2.5 py-1 text-xs text-slate-300">
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            live
          </span>
        </div>
        <p class="text-slate-300 max-w-lg leading-relaxed">
          Press Start to run. Session is cached so 2FA is only requested when
          Translation TMS invalidates it.
        </p>
      </header>

      <section class="rounded-2xl border border-slate-700/60 bg-slate-900/80 backdrop-blur shadow-xl shadow-black/40 overflow-hidden">
        <div id="result" class="p-8 sm:p-10">
          <div class="flex items-center justify-between gap-4">
            <div>
              <h2 class="text-base font-semibold text-white mb-1">Run automation</h2>
              <p class="text-sm text-slate-400">Will try the saved session first. If Translation TMS asks, you'll see a 2FA form.</p>
            </div>
            <button id="go" class="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
              Start
            </button>
          </div>
        </div>
      </section>

      <footer class="mt-8 text-xs text-slate-400 text-center">
        <a href="/health" class="hover:text-slate-600">/health</a>
      </footer>
    </main>
  <script>
    const out = document.getElementById('result');
    const go = document.getElementById('go');

    const DOT_ROW = (color, label) =>
      '<div class="flex items-center gap-3 text-' + color + '-300">'
      + '<span class="olaf-dot h-2 w-2 rounded-full bg-current"></span>'
      + '<span class="olaf-dot olaf-dot-2 h-2 w-2 rounded-full bg-current"></span>'
      + '<span class="olaf-dot olaf-dot-3 h-2 w-2 rounded-full bg-current"></span>'
      + '<span class="text-sm font-medium text-slate-200">' + escapeHtml(label) + '</span></div>';

    const ICON_OK =
      '<div class="h-10 w-10 rounded-xl bg-emerald-500/15 grid place-items-center text-emerald-400 mb-4">'
      + '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      + '</div>';
    const ICON_ERR =
      '<div class="h-10 w-10 rounded-xl bg-rose-500/15 grid place-items-center text-rose-400 mb-4">'
      + '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
      + '</div>';

    const RUN_BUTTON =
      '<button onclick="location.reload()" class="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-100 transition-colors">'
      + '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>'
      + 'Run again</button>';

    const RETRY_BUTTON =
      '<button onclick="location.reload()" class="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-transparent px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 transition-colors">'
      + '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>'
      + 'Retry</button>';

    go.addEventListener('click', async () => {
      go.disabled = true;
      out.innerHTML = DOT_ROW('slate', 'Starting');
      try {
        const r = await fetch('/run', { method: 'POST' });
        const j = await r.json();
        if (!j.ok) {
          out.innerHTML = ICON_ERR
            + '<h2 class="text-base font-semibold text-white mb-1">Could not start</h2>'
            + '<p class="text-sm text-slate-400 mb-6">' + escapeHtml(j.error || 'failed') + '</p>'
            + RETRY_BUTTON;
          go.disabled = false;
          return;
        }
        pollRun(j.runId);
      } catch (err) {
        out.innerHTML = ICON_ERR
          + '<h2 class="text-base font-semibold text-white mb-1">Network error</h2>'
          + '<p class="text-sm text-slate-400 mb-6">' + escapeHtml(err.message) + '</p>'
          + RETRY_BUTTON;
        go.disabled = false;
      }
    });

    async function pollRun(runId) {
      try {
        const r = await fetch('/run/' + runId);
        if (!r.ok) {
          out.innerHTML = ICON_ERR
            + '<h2 class="text-base font-semibold text-white mb-1">Lost the run</h2>'
            + '<p class="text-sm text-slate-400 mb-6">Server restarted mid-run.</p>'
            + RETRY_BUTTON;
          return;
        }
        const j = await r.json();
        if (j.requires2fa) {
          window.location.href = '/auth/' + runId;
          return;
        }
        if (j.state === 'done') {
          out.innerHTML = ICON_OK
            + '<h2 class="text-base font-semibold text-white mb-1">Done</h2>'
            + '<p class="text-sm text-slate-400 mb-4">Reached the job board.</p>'
            + '<pre class="rounded-lg bg-black/50 border border-slate-700/60 text-slate-200 p-4 text-xs font-mono overflow-x-auto mb-6 leading-relaxed">'
            + escapeHtml(JSON.stringify(j.result, null, 2))
            + '</pre>'
            + RUN_BUTTON;
          return;
        }
        if (j.state === 'failed') {
          out.innerHTML = ICON_ERR
            + '<h2 class="text-base font-semibold text-white mb-1">Run failed</h2>'
            + '<p class="text-sm text-slate-400 mb-6">' + escapeHtml(j.error || 'failed') + '</p>'
            + RETRY_BUTTON;
          return;
        }
        const label = ({
          starting: 'Starting',
          logging_in: 'Logging in',
          awaiting_2fa: 'Waiting for 2FA',
          running: 'Scraping job board',
        })[j.state] || j.state;
        out.innerHTML = DOT_ROW('slate', label);
        setTimeout(() => pollRun(runId), 1500);
      } catch (_) {
        setTimeout(() => pollRun(runId), 3000);
      }
    }

    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  </script>
</body>
</html>`;

function authHtml(runId, hint, error) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>olaf — 2FA required</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  </style>
</head>
<body class="min-h-screen bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-900 antialiased">
  <main class="mx-auto max-w-md px-6 py-16 sm:py-24">
      <header class="mb-8">
        <div class="flex items-center gap-3 mb-3">
          <div class="h-10 w-10 rounded-xl bg-slate-900 grid place-items-center text-white font-bold text-lg shadow-sm">o</div>
          <h1 class="text-xl font-semibold tracking-tight">olaf</h1>
        </div>
      </header>

      <section class="rounded-2xl border border-amber-200 bg-amber-50/40 p-6 sm:p-8 mb-6">
        <div class="flex items-center gap-2 text-amber-700 text-xs font-semibold uppercase tracking-wider mb-3">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>
          2FA required
        </div>
        <h2 class="text-base font-semibold text-slate-900 mb-1">Enter the one-time code</h2>
        <p class="text-sm text-slate-600">Translation TMS is asking for verification.</p>
      </section>

      <form method="POST" class="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 sm:p-8 space-y-5">
        <div>
          <label for="code" class="block text-sm font-medium text-slate-700 mb-2">Code</label>
          <input type="text" id="code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="8" pattern="[0-9]*"
            class="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-center font-mono text-2xl tracking-[0.4em] text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            autofocus required>
        </div>
        ${hint ? `<div class="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-600">Detected field: <code class="font-mono text-slate-900">${hint}</code></div>` : ''}
        ${error ? `<div class="rounded-lg bg-rose-50 border border-rose-100 px-3 py-2 text-sm text-rose-700">${error}</div>` : ''}
        <button type="submit"
          class="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors">
          Submit code
        </button>
        <div class="text-center text-xs text-slate-400 font-mono break-all">runId: ${runId}</div>
      </form>
    </main>
</body>
</html>`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.type('html').send(LANDING_HTML);
});

app.post('/run', (_req, res) => {
  if (!TMS_EMAIL || !TMS_PASSWORD) {
    return res.status(400).json({
      ok: false,
      error:
        'TRANSLATION_TMS_EMAIL and TRANSLATION_TMS_PASSWORD not set — fill them in /home/telchar/olaf-automation/.env and rebuild',
    });
  }
  const state = startRun();
  res.json({ ok: true, runId: state.id });
});

app.get('/run/:runId', (req, res) => {
  const state = runs.get(req.params.runId);
  if (!state) {
    return res.status(404).json({ ok: false, error: 'run not found (expired or server restarted)' });
  }
  res.json({ ok: true, ...snapshot(state) });
});

app.get('/auth/:runId', (req, res) => {
  const state = runs.get(req.params.runId);
  if (!state) {
    return res
      .status(404)
      .type('html')
      .send('<p>Run not found or expired. <a href="/">Back</a></p>');
  }
  if (state.state !== 'awaiting_2fa' || !state.twoFactor) {
    return res
      .status(410)
      .type('html')
      .send(
        `<p>This run is in state <code>${state.state}</code> — 2FA is not being asked for. ` +
          `<a href="/run/${state.id}">View result</a> or <a href="/">start another</a>.</p>`,
      );
  }
  res.type('html').send(authHtml(state.id, state.twoFactor.hint, null));
});

app.post('/auth/:runId', (req, res) => {
  const state = runs.get(req.params.runId);
  if (!state || state.state !== 'awaiting_2fa' || !state.twoFactor) {
    return res
      .status(410)
      .type('html')
      .send(
        `<p>This run is no longer waiting for a 2FA code. ` +
          `<a href="/">Start another</a>.</p>`,
      );
  }
  const code = String(req.body && req.body.code || '').trim();
  if (!/^\d{4,8}$/.test(code)) {
    return res
      .status(400)
      .type('html')
      .send(authHtml(state.id, state.twoFactor.hint, 'Code must be 4–8 digits.'));
  }
  state.twoFactor.resolve(code);
  state.twoFactor = null;
  res.redirect(`/run/${state.id}`);
});

app.listen(PORT, () => {
  if (!TMS_EMAIL || !TMS_PASSWORD) {
    console.warn(
      `[olaf] WARNING: TRANSLATION_TMS_EMAIL / TRANSLATION_TMS_PASSWORD not set in .env — /run will refuse until filled`,
    );
  }
  console.log(`[olaf] listening on :${PORT}`);
  console.log(`[olaf] target: ${JOB_BOARD_URL}`);
});