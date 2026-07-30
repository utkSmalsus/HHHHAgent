/**
 * Meetings → Qdrant normalization.
 * Reads the "Meetings" SharePoint list (metadata + inline transcript columns) and,
 * when a transcript lives as a .docx in the document library, downloads it via Graph
 * and extracts the raw text with mammoth.
 *
 * Transcript sources, in priority order (mirrors SPFx sharePointDataService):
 *   1. inline column TeamsTranscript / TranscriptText
 *   2. file at TranscriptUrl (.docx in Documents/Meeting/...) → Graph download + mammoth
 */
import mammoth from 'mammoth';

function decodeBasicEntities(value) {
  return String(value || '')
    .replace(/&#58;/g, ':')
    .replace(/&#160;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function cleanText(value) {
  return decodeBasicEntities(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function valueToText(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return cleanText(value.LookupValue || value.Title || value.Email || value.Name || '');
  }
  return cleanText(value);
}

function firstField(fields, names) {
  for (const name of names) {
    const v = fields[name];
    if (typeof v === 'string' ? v.trim() : v != null && v !== '') return valueToText(v);
  }
  return '';
}

/** Inline transcript text stored directly on the meeting row (no file needed). */
export function inlineTranscript(fields) {
  return (
    firstField(fields, ['TeamsTranscript', 'TranscriptText']) || ''
  );
}

/** Participants column is a JSON array of {LookupValue, Email}; extract names. */
function participantNames(raw) {
  if (!raw) return '';
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr)) {
      return arr.map((p) => p?.LookupValue || p?.name || p?.Email).filter(Boolean).join(', ');
    }
  } catch { /* not JSON — fall through */ }
  return valueToText(raw);
}

/** ActionItemJSON → readable action-item text (best-effort; skip raw JSON dumps). */
function actionItemsText(raw) {
  if (!raw) return '';
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr)) {
      return arr
        .map((a) => a?.description || a?.title || a?.text || a?.task)
        .filter(Boolean)
        .map((t) => cleanText(t))
        .join('; ');
    }
  } catch { /* not JSON */ }
  return '';
}

/**
 * Server-relative URL → drive-relative path for Graph `/drive/root:/{path}:/content`.
 * The document library (drive root) is "Documents" / "Shared Documents"; everything after it
 * is the drive-relative path. Validated against a real TranscriptUrl on /sites/HHHH/SP.
 *   /sites/HHHH/SP/Documents/Meeting/meetings/1/transcripts/x.docx → Meeting/meetings/1/transcripts/x.docx
 */
export function driveRelativePath(serverRelativeUrl) {
  let path = String(serverRelativeUrl || '').trim();
  if (!path) return '';
  path = path.replace(/^https?:\/\/[^/]+/i, ''); // drop host if absolute
  const parts = path.split('/').filter(Boolean);
  const libIdx = parts.findIndex((p) => /^(shared[%\s]+)?documents$/i.test(decodeURIComponent(p)));
  // after the library segment; fallback to after /sites/<one-segment>/<library>/
  const start = libIdx >= 0 ? libIdx + 1 : Math.max(1, parts.findIndex((p) => p.toLowerCase() === 'sites') + 3);
  return parts.slice(start).map(encodeURIComponent).join('/');
}

/** Download a .docx transcript via Graph and return its raw text (best-effort). */
export async function fetchTranscriptText(token, siteId, transcriptUrl) {
  const rel = driveRelativePath(transcriptUrl);
  if (!rel) return '';
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${rel}:/content`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return '';
    const buffer = Buffer.from(await res.arrayBuffer());
    const result = await mammoth.extractRawText({ buffer });
    return cleanText(result.value || '');
  } catch {
    return '';
  }
}

/** Build the {text, metadata, structured} knowledge point for a meeting row. */
export function meetingToKnowledge(row, source, transcriptText = '') {
  const fields = row.fields || {};
  const id = Number(row.id ?? row.Id);
  const title = firstField(fields, ['Title']) || `Meeting ${id}`;
  const type = firstField(fields, ['MeetingType', 'Meeting_x0020_Type']);
  const status = firstField(fields, ['Status', 'MeetingStatus']);
  const start = firstField(fields, ['Start', 'StartDateTime', 'Start_x0020_Time']);
  const end = firstField(fields, ['End', 'EndDateTime', 'End_x0020_Time']);
  const priority = firstField(fields, ['MeetingPriority']);
  const description = firstField(fields, ['Description', 'Agenda', 'AgendaItems', 'Body']);
  const summary = firstField(fields, ['AISummary', 'AI_x0020_Summary', 'Summary']);
  const actionItems = actionItemsText(fields.ActionItemJSON) || firstField(fields, ['ActionItems']);
  const participants = participantNames(fields.Participants);
  const transcript = transcriptText || inlineTranscript(fields);

  const parts = [title];
  if (type) parts.push(`Type: ${type}`);
  if (status) parts.push(`Status: ${status}`);
  if (start) parts.push(`Start: ${start}`);
  if (end) parts.push(`End: ${end}`);
  if (priority) parts.push(`Priority: ${priority}`);
  if (participants) parts.push(`Participants: ${participants}`);
  if (description) parts.push(`Description: ${description}`);
  if (summary) parts.push(`Summary: ${summary}`);
  if (actionItems) parts.push(`Action Items: ${actionItems}`);
  if (transcript) parts.push(`Transcript: ${transcript}`);

  return {
    text: parts.join('. '),
    metadata: {
      type: 'meeting',
      title,
      meetingId: id,
      meetingType: type || null,
      status: status || null,
      start: start || null,
      end: end || null,
      hasTranscript: Boolean(transcript),
      transcriptChars: transcript.length,
      sharePointItemId: id,
      sharePointSite: source.siteAlias,
      sharePointSiteId: source.siteId,
      sharePointListId: source.listId,
      sharePointListEnv: source.envVar,
      timestamp: fields.Modified || fields.Created || new Date().toISOString().slice(0, 10),
    },
    structured: { id, title, type, status, start, end, hasTranscript: Boolean(transcript) },
  };
}
