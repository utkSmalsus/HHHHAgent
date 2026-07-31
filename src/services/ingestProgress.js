const listeners = new Set();
let cancelRequested = false;

const state = {
  status: 'idle', // idle | running | completed | failed | cancelled
  jobId: null,
  currentList: null,
  phase: null, // fetching | embedding
  processed: 0,
  total: 0,
  totalIngested: 0,
  lists: {},
  startedAt: null,
  finishedAt: null,
  elapsedMs: 0,
  error: null,
  lastItem: null,
};

function emit() {
  const snapshot = getProgress();
  for (const fn of listeners) {
    fn(snapshot);
  }
}

export function onProgress(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function renderBar(percent, width = 30) {
  const pct = Math.min(100, Math.max(0, percent));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct.toFixed(1)}%`;
}

export function getProgress() {
  const percent =
    state.total > 0 ? Math.round((state.processed / state.total) * 1000) / 10 : 0;

  if (state.startedAt && state.status === 'running') {
    state.elapsedMs = Date.now() - new Date(state.startedAt).getTime();
  }

  return {
    status: state.status,
    jobId: state.jobId,
    currentList: state.currentList,
    phase: state.phase,
    processed: state.processed,
    total: state.total,
    totalIngested: state.totalIngested,
    percent,
    progressBar: renderBar(percent),
    lists: { ...state.lists },
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    elapsedMs: state.elapsedMs,
    elapsedSec: Math.round(state.elapsedMs / 1000),
    error: state.error,
    lastItem: state.lastItem,
    message: buildMessage(state, percent),
  };
}

function buildMessage(s, percent) {
  if (s.status === 'idle') return 'No ingest running. POST /api/ingest/all to start.';
  if (s.status === 'completed') {
    return `Done. ${s.totalIngested} items fed into Qdrant.`;
  }
  if (s.status === 'cancelled') {
    return `Stopped. ${s.totalIngested} items fed into Qdrant before stopping.`;
  }
  if (s.status === 'failed') return `Failed: ${s.error}`;
  if (s.phase === 'fetching') {
    return `Fetching ${s.currentList} from SharePoint…`;
  }
  return `Embedding ${s.currentList}: ${s.processed}/${s.total} (${percent}%)`;
}

export function isRunning() {
  return state.status === 'running';
}

/** Signal the running job to stop after its current item — checked inside the ingest loop. */
export function requestCancel() {
  if (state.status === 'running') cancelRequested = true;
  return cancelRequested;
}

export function isCancelRequested() {
  return cancelRequested;
}

export function cancelJob() {
  state.status = 'cancelled';
  state.finishedAt = new Date().toISOString();
  state.elapsedMs = Date.now() - new Date(state.startedAt).getTime();
  cancelRequested = false;
  emit();
  logProgress(true);
}

export function startJob(jobId, listKeys) {
  cancelRequested = false;
  Object.assign(state, {
    status: 'running',
    jobId,
    currentList: null,
    phase: 'fetching',
    processed: 0,
    total: 0,
    totalIngested: 0,
    lists: Object.fromEntries(
      listKeys.map((k) => [k, { status: 'pending', fetched: 0, ingested: 0, percent: 0 }])
    ),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: 0,
    error: null,
    lastItem: null,
  });
  emit();
  logProgress();
}

export function setPhase(phase, listKey) {
  state.phase = phase;
  if (listKey) state.currentList = listKey;
  if (listKey && state.lists[listKey]) {
    state.lists[listKey].status = phase === 'fetching' ? 'fetching' : 'embedding';
  }
  emit();
  logProgress();
}

export function setListFetched(listKey, count) {
  if (state.lists[listKey]) {
    state.lists[listKey].fetched = count;
    state.lists[listKey].status = 'embedding';
  }
  state.total += count;
  emit();
}

export function tick(listKey, itemTitle) {
  state.processed += 1;
  state.totalIngested += 1;
  state.lastItem = itemTitle || null;
  if (state.lists[listKey]) {
    state.lists[listKey].ingested += 1;
    const t = state.lists[listKey].fetched || state.total;
    state.lists[listKey].percent =
      t > 0 ? Math.round((state.lists[listKey].ingested / t) * 1000) / 10 : 0;
  }
  emit();
  if (state.processed % 5 === 0 || state.processed === state.total) {
    logProgress();
  }
}

export function completeList(listKey, ingested) {
  if (state.lists[listKey]) {
    state.lists[listKey].status = 'done';
    state.lists[listKey].ingested = ingested;
    state.lists[listKey].percent = 100;
  }
  emit();
  logProgress();
}

export function finishJob() {
  state.status = 'completed';
  state.phase = 'done';
  state.finishedAt = new Date().toISOString();
  state.elapsedMs = Date.now() - new Date(state.startedAt).getTime();
  emit();
  logProgress(true);
}

export function failJob(error) {
  state.status = 'failed';
  state.error = String(error?.message || error);
  state.finishedAt = new Date().toISOString();
  emit();
  console.error(`\n❌ Ingest failed: ${state.error}\n`);
}

function logProgress(final = false) {
  const p = getProgress();
  const line = final
    ? `\n✅ Ingest complete | ${p.totalIngested} items | ${p.elapsedSec}s\n`
    : `\r${p.progressBar} | ${p.processed}/${p.total} | ${p.currentList || '-'} | ${p.lastItem?.slice(0, 40) || ''}`.padEnd(
        100
      );
  process.stdout.write(line);
  if (final) process.stdout.write('\n');
}
