import { fetchListItems } from './sharepoint.js';
import { upsertKnowledge } from './qdrant.js';
import { clearIngestCache } from './hierarchyIngest.js';
import * as progress from './ingestProgress.js';

export async function ingestFromSharePoint(listKey, { trackProgress = true, modifiedSince } = {}) {
  if (trackProgress) progress.setPhase('fetching', listKey);

  const { items, configured, sources } = await fetchListItems(listKey, { modifiedSince });

  if (!configured) {
    return { ingested: 0, message: 'SharePoint not configured — provide items in request body' };
  }

  if (trackProgress) {
    progress.setListFetched(listKey, items.length);
    progress.setPhase('embedding', listKey);
  }

  const results = [];
  const skipped = [];
  // Aggregate audit numbers per requirement: records fetched vs. actually chunked/embedded/
  // stored, so a 100% progress bar can't silently mean "some records lost data along the way".
  const audit = {
    recordsFetched: items.length,
    recordsProcessed: 0,
    recordsFailed: 0,
    recordsChunked: 0,
    totalChunksCreated: 0,
    embeddingsOk: 0,
    embeddingsFailed: 0,
  };

  for (const item of items) {
    if (trackProgress && progress.isCancelRequested()) break;
    try {
      const stored = await upsertKnowledge({
        text: item.text,
        metadata: item.metadata,
      });
      results.push(stored);
      audit.recordsProcessed += 1;
      if (stored.stats?.chunked) audit.recordsChunked += 1;
      audit.totalChunksCreated += stored.stats?.totalChunks || 1;
      audit.embeddingsOk += stored.stats?.embeddingsOk || 0;
      audit.embeddingsFailed += stored.stats?.embeddingsFailed || 0;
      if (trackProgress) {
        progress.tick(listKey, item.metadata?.title || item.metadata?.projectName || item.text?.slice(0, 50));
      }
    } catch (err) {
      const label =
        item.metadata?.sharePointItemId ||
        item.metadata?.title ||
        item.text?.slice(0, 40) ||
        'unknown';
      console.warn(`Ingest skip [${listKey}] ${label}:`, err.message);
      skipped.push({ id: label, error: err.message });
      audit.recordsFailed += 1;
      if (trackProgress) {
        progress.tick(listKey, `skipped: ${label}`);
      }
    }
  }

  const status = audit.recordsFailed === 0 && audit.embeddingsFailed === 0 ? 'SUCCESS' : audit.recordsProcessed > 0 ? 'PARTIAL' : 'FAILED';
  console.log(
    `[INGEST AUDIT] ${listKey}: fetched=${audit.recordsFetched} processed=${audit.recordsProcessed} ` +
      `failed=${audit.recordsFailed} chunked=${audit.recordsChunked} chunks=${audit.totalChunksCreated} ` +
      `embeddings=${audit.embeddingsOk}/${audit.embeddingsOk + audit.embeddingsFailed} status=${status}`
  );

  if (trackProgress) progress.completeList(listKey, results.length, audit);

  return {
    ingested: results.length,
    skipped: skipped.length,
    skipErrors: skipped.slice(0, 20),
    points: results,
    sources,
    audit: { ...audit, status },
  };
}

export async function ingestManualItems(items) {
  const results = [];
  for (const item of items) {
    const stored = await upsertKnowledge({
      text: item.text,
      metadata: item.metadata || {},
    });
    results.push(stored);
  }
  return { ingested: results.length, points: results };
}

export async function runIngestAll(listKeys, { modifiedSince } = {}) {
  const jobId = `ingest-${Date.now()}`;
  clearIngestCache();
  progress.startJob(jobId, listKeys);

  // Run every list concurrently instead of one-by-one. Safe because: (1) each list's progress
  // lives at state.lists[listKey] — independent keys, no shared counter to race; (2) the shared
  // master-item cache in hierarchyIngest.js is only ever overwritten with equivalent data (tasks/
  // timeentries may redundantly re-fetch the same master rows portfolio already cached, but never
  // corrupt each other — JS only yields at `await`, so no torn writes). allSettled (not all) so
  // one list failing doesn't abort the others.
  const settled = await Promise.allSettled(
    listKeys.map((listKey) => ingestFromSharePoint(listKey, { modifiedSince }))
  );

  const results = {};
  const combinedAudit = {
    recordsFetched: 0,
    recordsProcessed: 0,
    recordsFailed: 0,
    recordsChunked: 0,
    totalChunksCreated: 0,
    embeddingsOk: 0,
    embeddingsFailed: 0,
  };
  settled.forEach((outcome, i) => {
    const listKey = listKeys[i];
    if (outcome.status === 'fulfilled') {
      const result = outcome.value;
      results[listKey] = { ingested: result.ingested, sources: result.sources, message: result.message, audit: result.audit };
      if (result.audit) {
        for (const key of Object.keys(combinedAudit)) combinedAudit[key] += result.audit[key] || 0;
      }
    } else {
      const message = outcome.reason?.message || String(outcome.reason);
      console.error(`Ingest ${listKey} failed:`, message);
      results[listKey] = { ingested: 0, message };
    }
  });
  const auditStatus = combinedAudit.recordsFailed === 0 && combinedAudit.embeddingsFailed === 0 ? 'SUCCESS' : 'PARTIAL';
  console.log(
    `[INGEST AUDIT] FULL: fetched=${combinedAudit.recordsFetched} processed=${combinedAudit.recordsProcessed} ` +
      `failed=${combinedAudit.recordsFailed} chunked=${combinedAudit.recordsChunked} chunks=${combinedAudit.totalChunksCreated} ` +
      `embeddings=${combinedAudit.embeddingsOk}/${combinedAudit.embeddingsOk + combinedAudit.embeddingsFailed} status=${auditStatus}`
  );

  if (progress.isCancelRequested()) {
    progress.cancelJob();
    return { success: true, jobId, cancelled: true, totalIngested: progress.getProgress().totalIngested, results, audit: { ...combinedAudit, status: auditStatus } };
  }

  if (settled.every((o) => o.status === 'rejected')) {
    const err = settled[0].reason;
    progress.failJob(err);
    throw err;
  }

  progress.finishJob();
  return { success: true, jobId, totalIngested: progress.getProgress().totalIngested, results, audit: { ...combinedAudit, status: auditStatus } };
}

export async function runIngestOne(listKey) {
  const jobId = `ingest-${listKey}-${Date.now()}`;
  clearIngestCache();
  progress.startJob(jobId, [listKey]);
  try {
    const result = await ingestFromSharePoint(listKey);
    if (progress.isCancelRequested()) {
      progress.cancelJob();
      return { success: true, jobId, type: listKey, cancelled: true, ...result };
    }
    progress.finishJob();
    return { success: true, jobId, type: listKey, ...result };
  } catch (err) {
    progress.failJob(err);
    throw err;
  }
}
