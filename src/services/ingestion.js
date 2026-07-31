import { fetchListItems } from './sharepoint.js';
import { upsertKnowledge } from './qdrant.js';
import { clearIngestCache } from './hierarchyIngest.js';
import * as progress from './ingestProgress.js';

export async function ingestFromSharePoint(listKey, { trackProgress = true } = {}) {
  if (trackProgress) progress.setPhase('fetching', listKey);

  const { items, configured, sources } = await fetchListItems(listKey);

  if (!configured) {
    return { ingested: 0, message: 'SharePoint not configured — provide items in request body' };
  }

  if (trackProgress) {
    progress.setListFetched(listKey, items.length);
    progress.setPhase('embedding', listKey);
  }

  const results = [];
  const skipped = [];
  for (const item of items) {
    if (trackProgress && progress.isCancelRequested()) break;
    try {
      const stored = await upsertKnowledge({
        text: item.text,
        metadata: item.metadata,
      });
      results.push(stored);
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
      if (trackProgress) {
        progress.tick(listKey, `skipped: ${label}`);
      }
    }
  }

  if (trackProgress) progress.completeList(listKey, results.length);

  return { ingested: results.length, skipped: skipped.length, skipErrors: skipped.slice(0, 20), points: results, sources };
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

export async function runIngestAll(listKeys) {
  const jobId = `ingest-${Date.now()}`;
  clearIngestCache();
  progress.startJob(jobId, listKeys);

  const results = {};
  try {
    for (const listKey of listKeys) {
      if (progress.isCancelRequested()) break;
      const result = await ingestFromSharePoint(listKey);
      results[listKey] = {
        ingested: result.ingested,
        sources: result.sources,
        message: result.message,
      };
    }
    if (progress.isCancelRequested()) {
      progress.cancelJob();
      return { success: true, jobId, cancelled: true, totalIngested: progress.getProgress().totalIngested, results };
    }
    progress.finishJob();
    return { success: true, jobId, totalIngested: progress.getProgress().totalIngested, results };
  } catch (err) {
    progress.failJob(err);
    throw err;
  }
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
