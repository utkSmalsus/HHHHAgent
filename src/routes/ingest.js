import { Router } from 'express';
import { randomUUID } from 'crypto';
import {
  ingestFromSharePoint,
  ingestManualItems,
  runIngestAll,
  runIngestOne,
} from '../services/ingestion.js';
import { getSharePointSitesConfig } from '../services/sharepoint.js';
import { getProgress, isRunning, onProgress } from '../services/ingestProgress.js';
import { config } from '../config.js';

const router = Router();

router.get('/config', (_req, res) => {
  res.json({ success: true, sharepoint: getSharePointSitesConfig() });
});

/** Live progress JSON — poll every 1–2s while ingest runs */
router.get('/progress', (_req, res) => {
  res.json({ success: true, ...getProgress() });
});

/** Server-Sent Events — live progress stream in browser/terminal */
router.get('/progress/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send(getProgress());
  const unsubscribe = onProgress(send);

  req.on('close', () => {
    unsubscribe();
    res.end();
  });
});

/** Simple HTML page with progress bar */
router.get('/progress/ui', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Ingest Progress</title>
  <style>
    body { font-family: system-ui; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.25rem; }
    #bar-wrap { background: #e5e7eb; border-radius: 8px; height: 28px; overflow: hidden; margin: 1rem 0; }
    #bar { background: linear-gradient(90deg,#2563eb,#3b82f6); height: 100%; width: 0%; transition: width 0.3s; }
    #pct { font-size: 2rem; font-weight: 700; }
    #msg { color: #374151; margin: 0.5rem 0; }
    #lists { margin-top: 1.5rem; }
    .list-row { display: flex; justify-content: space-between; padding: 0.35rem 0; border-bottom: 1px solid #f3f4f6; }
    .done { color: #059669; } .running { color: #2563eb; } .pending { color: #9ca3af; }
    button { margin: 1rem 0.5rem 0 0; padding: 0.5rem 1rem; cursor: pointer; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; }
    button:hover { background: #f1f5f9; }
    button.full { background: #2563eb; color: #fff; border-color: #2563eb; }
    button:disabled { opacity: 0.5; cursor: default; }
    #buttons { display: flex; flex-wrap: wrap; }
  </style>
</head>
<body>
  <h1>SharePoint → Qdrant ingest</h1>
  <div id="pct">0%</div>
  <div id="bar-wrap"><div id="bar"></div></div>
  <div id="msg">Connecting…</div>
  <div id="meta"></div>
  <div id="lists"></div>
  <div id="buttons">
    <button onclick="ingest('portfolio', this)">Portfolio</button>
    <button onclick="ingest('projects', this)">Projects</button>
    <button onclick="ingest('tasks', this)">Tasks</button>
    <button onclick="ingest('timeentries', this)">Time Entries</button>
    <button onclick="ingest('meetings', this)">Meetings + Transcripts</button>
    <button class="full" onclick="ingest('all', this)">Full ingest</button>
  </div>
  <script>
    const es = new EventSource('/api/ingest/progress/stream');
    es.onmessage = (e) => update(JSON.parse(e.data));
    function update(p) {
      document.getElementById('pct').textContent = p.percent + '%';
      document.getElementById('bar').style.width = p.percent + '%';
      document.getElementById('msg').textContent = p.message || '';
      document.getElementById('meta').textContent =
        (p.status === 'running' ? p.processed + '/' + p.total + ' items · ' + p.elapsedSec + 's' : p.status);
      const running = p.status === 'running';
      document.querySelectorAll('#buttons button').forEach((b) => { b.disabled = running; });
      const lists = Object.entries(p.lists || {}).map(([k,v]) =>
        '<div class="list-row ' + v.status + '"><span>' + k + '</span><span>' +
        (v.ingested || 0) + '/' + (v.fetched || '?') + ' (' + (v.percent||0) + '%)</span></div>'
      ).join('');
      document.getElementById('lists').innerHTML = lists ? '<h3>Lists</h3>' + lists : '';
    }
    async function ingest(key, btn) {
      btn.disabled = true;
      const res = await fetch('/api/ingest/' + key, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        document.getElementById('msg').textContent = 'Error: ' + (err.error || res.status);
        btn.disabled = false;
      }
    }
  </script>
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
