// Olaf automation — Playwright + 2FA pause para Translation TMS.
//
// Endpoints
//   GET  /                  → landing HTML (botón "Start")
//   POST /run               → {ok, runId}   kicks off async run
//   GET  /run/:runId        → {state, ...}  poll for status / result
//   GET  /auth/:runId       → HTML form para meter el código 2FA
//   POST /auth/:runId       → resuelve el promise que Playwright espera
//
// Flujo: Playwright login → si aparece un selector 2FA, pausa y expone
// /auth/:runId → cuando llega el código, sigue al job-board → resultado
// visible en /run/:runId. ponytail: in-memory registry, TTL 30 min, sin
// persistencia — si reiniciás el container se pierden runs en vuelo.

const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');

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
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/131.0.0.0 Safari/537.36 OlafAutomation/0.1',
    });
    const page = await context.newPage();

    // 1. Navegar al login.
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

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

    // 6. Ir al job-board.
    state.state = 'running';
    state.twoFactor = null; // ya no aplica
    await page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
  <style>
    body { font: 14px/1.5 system-ui, -apple-system, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
    p { color: #666; margin-top: 0; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.25rem; margin-top: 1.5rem; }
    button { font: inherit; padding: 0.5rem 1rem; border: 0; background: #0d6efd; color: #fff; border-radius: 6px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    pre { background: #f5f5f5; border-radius: 4px; padding: 0.5rem; margin: 0.5rem 0 0; font-size: 12px; overflow-x: auto; }
    .ok { color: #198754; } .err { color: #dc3545; }
    .status { font-family: ui-monospace, monospace; font-size: 12px; color: #666; }
    code { background: #f5f5f5; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>olaf</h1>
  <p>Playwright automation for Translation TMS</p>
  <div class="card">
    <p style="margin-top:0"><strong>Run automation</strong></p>
    <p style="font-size:13px">Uses credentials from <code>.env</code>. If 2FA is enabled you'll be redirected to enter the code.</p>
    <button type="button" id="go">Start</button>
    <div id="result" style="margin-top: 1rem"></div>
  </div>
  <script>
    const go = document.getElementById('go');
    const out = document.getElementById('result');
    go.addEventListener('click', async () => {
      go.disabled = true;
      out.innerHTML = '<p>Starting…</p>';
      try {
        const r = await fetch('/run', { method: 'POST' });
        const j = await r.json();
        if (!j.ok) {
          out.innerHTML = '<p class="err">' + escapeHtml(j.error || 'failed') + '</p>';
          go.disabled = false;
          return;
        }
        pollRun(j.runId);
      } catch (err) {
        out.innerHTML = '<p class="err">' + escapeHtml(err.message) + '</p>';
        go.disabled = false;
      }
    });
    async function pollRun(runId) {
      try {
        const r = await fetch('/run/' + runId);
        if (!r.ok) {
          out.innerHTML = '<p class="err">Lost the run (server restarted?)</p>';
          go.disabled = false;
          return;
        }
        const j = await r.json();
        if (j.requires2fa) {
          window.location.href = '/auth/' + runId;
          return;
        }
        if (j.state === 'done') {
          out.innerHTML = '<p class="ok">Done.</p><pre>' + escapeHtml(JSON.stringify(j.result, null, 2)) + '</pre>';
          go.disabled = false;
          return;
        }
        if (j.state === 'failed') {
          out.innerHTML = '<p class="err">' + escapeHtml(j.error || 'failed') + '</p>';
          go.disabled = false;
          return;
        }
        out.innerHTML = '<p class="status">' + escapeHtml(j.state) + '…</p>';
        setTimeout(() => pollRun(runId), 1500);
      } catch (err) {
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
  <style>
    body { font: 14px/1.5 system-ui, -apple-system, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
    p { color: #666; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.25rem; margin-top: 1.5rem; }
    label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
    input[type=text] { font: inherit; padding: 0.6rem; border: 1px solid #ccc; border-radius: 4px; width: 100%; box-sizing: border-box; letter-spacing: 0.3em; font-family: ui-monospace, monospace; font-size: 1.4rem; text-align: center; }
    button { font: inherit; padding: 0.5rem 1rem; border: 0; background: #0d6efd; color: #fff; border-radius: 6px; cursor: pointer; margin-top: 0.75rem; }
    .meta { font-family: ui-monospace, monospace; font-size: 11px; color: #999; margin-top: 1rem; word-break: break-all; }
    .err { color: #dc3545; margin-top: 0.5rem; }
    .hint { background: #f8f9fa; border-radius: 4px; padding: 0.5rem; font-size: 12px; margin-top: 0.75rem; color: #555; }
    code { background: #f5f5f5; padding: 0.1rem 0.3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>2FA required</h1>
  <p>Translation TMS is asking for a one-time code.</p>
  <div class="card">
    <form method="POST">
      <label for="code">Code</label>
      <input type="text" id="code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="8" pattern="[0-9]*" autofocus required>
      ${hint ? `<div class="hint">Detected field: <code>${hint}</code></div>` : ''}
      ${error ? `<p class="err">${error}</p>` : ''}
      <button type="submit">Submit</button>
    </form>
    <div class="meta">runId: ${runId}</div>
  </div>
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