import { Router } from 'express';
import { randomUUID } from 'crypto';
import {
  ingestFromSharePoint,
  ingestManualItems,
  runIngestAll,
  runIngestOne,
} from '../services/ingestion.js';
import { getSharePointSitesConfig } from '../services/sharepoint.js';
import { getProgress, getProgressWithDbState, isRunning, onProgress, requestCancel } from '../services/ingestProgress.js';
import { config } from '../config.js';

const router = Router();

router.get('/config', (_req, res) => {
  res.json({ success: true, sharepoint: getSharePointSitesConfig() });
});

/** Live progress JSON — poll every 1–2s while ingest runs */
router.get('/progress', async (_req, res) => {
  res.json({ success: true, ...(await getProgressWithDbState()) });
});

/** Stop the running ingest after its current item — remaining items/lists are skipped. */
router.post('/stop', (_req, res) => {
  if (!isRunning()) {
    return res.status(409).json({ success: false, error: 'No ingest running' });
  }
  requestCancel();
  res.json({ success: true, message: 'Stopping after current item…', ...getProgress() });
});

/** Server-Sent Events — live progress stream in browser/terminal */
router.get('/progress/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send(await getProgressWithDbState());
  const unsubscribe = onProgress(send);

  req.on('close', () => {
    unsubscribe();
    res.end();
  });
});

/** Ingest progress dashboard — one progress bar per dataset, live via SSE. */
router.get('/progress/ui', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Ingest Progress</title>
  <link rel="stylesheet" href="/ingest-ui.css"/>
  <script>
    // Set the saved theme before first paint, else the page flashes light then re-themes.
    try { document.documentElement.setAttribute('data-theme', localStorage.getItem('omt_theme') || 'light'); } catch (e) {}
  </script>
</head>
<body>
  <header>
    <span class="brand">SharePoint → Qdrant ingest</span>
    <span class="actions">
      <button class="hdr-btn" id="themeToggle" type="button" title="Toggle theme" aria-label="Toggle theme">
        <svg id="iconMoon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg id="iconSun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" hidden><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      </button>
      <a class="hdr-btn" href="/api/query/ui" title="Back to chat" aria-label="Back to chat">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      </a>
    </span>
  </header>
  <main>
    <div class="summary">
      <div class="summary-top">
        <span class="summary-pct" id="summaryPct">0%</span>
        <span class="summary-msg" id="summaryMsg">Connecting…</span>
      </div>
      <div class="bar-wrap"><div class="bar-fill" id="summaryBar"></div></div>
      <div class="summary-meta" id="summaryMeta"></div>
    </div>
    <div class="controls">
      <button class="primary" id="fullIngest" type="button">Full ingest</button>
      <button class="stop" id="stopBtn" type="button" disabled>Stop</button>
    </div>
    <div class="grid" id="grid"></div>
  </main>
  <script src="/ingest-ui.js"></script>
</body>
</html>`);
});

const TYPE_MAP = {
  portfolio: 'portfolio',
  projects: 'project',
  tasks: 'task',
  timeentries: 'timeentry',
  meetings: 'meeting',
};

async function handleIngest(req, res, listKey) {
  try {
    if (isRunning()) {
      return res.status(409).json({
        success: false,
        error: 'Ingest already in progress',
        progress: getProgress(),
      });
    }

    const manualItems = req.body?.items;
    let result;

    if (manualItems?.length) {
      const type = TYPE_MAP[listKey] || listKey;
      const items = manualItems.map((item) => ({
        text: item.text,
        metadata: { type, ...item.metadata },
      }));
      result = await ingestManualItems(items);
      res.json({ success: true, type: listKey, ...result });
    } else {
      runIngestOne(listKey)
        .then((r) => console.log(`Ingest ${listKey} finished:`, r.ingested))
        .catch((e) => console.error(`Ingest ${listKey} failed:`, e.message));
      res.json({
        success: true,
        message: `Ingest started for ${listKey}`,
        progressUrl: '/api/ingest/progress',
        uiUrl: '/api/ingest/progress/ui',
        ...getProgress(),
      });
    }
  } catch (err) {
    console.error(`Ingest ${listKey} error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

router.post('/portfolio', (req, res) => handleIngest(req, res, 'portfolio'));
router.post('/projects', (req, res) => handleIngest(req, res, 'projects'));
router.post('/tasks', (req, res) => handleIngest(req, res, 'tasks'));
router.post('/timeentries', (req, res) => handleIngest(req, res, 'timeentries'));
router.post('/meetings', (req, res) => handleIngest(req, res, 'meetings'));

router.post('/all', async (req, res) => {
  try {
    if (isRunning()) {
      return res.status(409).json({
        success: false,
        error: 'Ingest already in progress',
        progress: getProgress(),
      });
    }

    const jobId = randomUUID();
    runIngestAll(config.sharepoint.ingestListKeys)
      .then((r) => console.log('Ingest all finished:', r.totalIngested))
      .catch((e) => console.error('Ingest all failed:', e.message));

    res.json({
      success: true,
      message: 'Full ingest started in background',
      jobId,
      progressUrl: '/api/ingest/progress',
      streamUrl: '/api/ingest/progress/stream',
      uiUrl: '/api/ingest/progress/ui',
      ...getProgress(),
    });
  } catch (err) {
    console.error('Ingest all error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
