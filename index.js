// Olaf automation — Playwright driver expuesto vía HTTP en olaf.andresmorales.com.co.
// Endpoints:
//   GET  /                  health
//   POST /run               lanza una corrida contra JOB_BOARD_URL (vista "in progress")
//   POST /run/:jobId        lanza una corrida y abre la oferta jobId
//
// Se serializa: solo una corrida a la vez (lock en memoria). El sub es
// deliberadamente simple — un solo browser context por corrida. Subir a
// múltiples workers cuando el volumen lo pida. ponytail: lock en memoria,
// upgrade a Redis SETNX si se quiere correr multi-instancia.

const express = require('express');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 3018);
// Vista filtrada: tab=job + jobTab=inProgress muestra solo los jobs en curso.
// Los filtros locales/statuses/projectIds llegan vacíos — la UI los
// puebla vía XHR al primer click, así que navegar con la URL basta para
// entrar al listado.
const JOB_BOARD_URL =
  process.env.JOB_BOARD_URL ||
  'https://www.translationtms.com/job-board?locales=&statuses=&projectIds=&jobTab=inProgress&tab=job';
const TARGET = JOB_BOARD_URL;

const app = express();
app.use(express.json({ limit: '64kb' }));

let running = false;
const lastRun = { startedAt: null, finishedAt: null, status: 'idle', lastError: null };

app.get('/', (_req, res) => {
  res.json({ service: 'olaf', status: running ? 'running' : 'idle', lastRun });
});

async function withTimeout(promise, ms, label) {
  let to;
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(to);
  }
}

async function runOnce(opts = {}) {
  if (running) throw new Error('A run is already in progress');
  running = true;
  lastRun.startedAt = new Date().toISOString();
  lastRun.status = 'running';
  lastRun.lastError = null;

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

    const url = opts.jobId
      ? `https://www.translationtms.com/job-board/${encodeURIComponent(opts.jobId)}`
      : TARGET;

    // Espera dinámica: primero domcontentloaded, después un selector que
    // debería existir en la página de ofertas. Si no aparece, igual
    // devolvemos lo que tengamos — la página puede haber cargado sin
    // tarjetas visibles.
    await withTimeout(
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }),
      65_000,
      'page.goto',
    );

    // job-board suele renderizar tarjetas o filas tras XHR; esperamos una
    // red corta a ver si llega algo antes de seguir.
    try {
      await withTimeout(
        page.waitForLoadState('networkidle', { timeout: 10_000 }),
        12_000,
        'networkidle',
      );
    } catch (_) {
      // No bloqueamos por networkidle — muchas páginas tienen tráfico de
      // tracking interminable.
    }

    const title = await page.title();
    const finalUrl = page.url();
    const heading = await page.locator('h1, h2').first().textContent().catch(() => null);

    return {
      title: title && title.trim(),
      finalUrl,
      heading: heading && heading.trim(),
    };
  } finally {
    await browser.close().catch(() => {});
    running = false;
    lastRun.finishedAt = new Date().toISOString();
    lastRun.status = lastRun.lastError ? 'failed' : 'succeeded';
  }
}

app.post('/run', async (req, res) => {
  try {
    const result = await runOnce(req.body || {});
    res.json({ ok: true, result, lastRun });
  } catch (err) {
    lastRun.lastError = String(err && err.message || err);
    lastRun.finishedAt = new Date().toISOString();
    lastRun.status = 'failed';
    res.status(500).json({ ok: false, error: lastRun.lastError, lastRun });
  }
});

app.post('/run/:jobId', async (req, res) => {
  try {
    const result = await runOnce({ jobId: req.params.jobId });
    res.json({ ok: true, result, lastRun });
  } catch (err) {
    lastRun.lastError = String(err && err.message || err);
    lastRun.finishedAt = new Date().toISOString();
    lastRun.status = 'failed';
    res.status(500).json({ ok: false, error: lastRun.lastError, lastRun });
  }
});

app.listen(PORT, () => {
  console.log(`[olaf] listening on :${PORT} — target ${TARGET}`);
});