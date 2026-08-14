import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

// Stored on a dedicated Docker volume (not the app image), so it survives `docker compose up
// --build` — the whole point is remembering the last successful run ACROSS container rebuilds.
const STATE_DIR = process.env.INGEST_STATE_DIR || path.join(process.cwd(), '.state');
const STATE_FILE = path.join(STATE_DIR, 'last-ingest.json');

export async function getLastIngestAt() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw).lastIngestAt || null;
  } catch {
    return null; // no state file yet — first run
  }
}

export async function setLastIngestAt(iso) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ lastIngestAt: iso }, null, 2));
}
