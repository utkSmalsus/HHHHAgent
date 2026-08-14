// Standalone port of php-mcp/lib/StructuredFilters.php — deliberately the SIMPLER capability level
// (person/date/status/overdue + dedupe, no container/project-NAME filtering, no chrono-node), not
// the more complex ../src/services/structuredFilters.js the main app uses. This file must stay in
// sync with StructuredFilters.php, not with the main app's version — they now support different
// things on purpose (see php-mcp/lib/StructuredFilters.php's own header comment for why container
// resolution was never ported there either).

const NAME_STOPWORDS = new Set([
  'how', 'many', 'does', 'is', 'are', 'has', 'have', 'the', 'this', 'that', 'those', 'these',
  'show', 'tell', 'what', 'who', 'when', 'where', 'which', 'why', 'team', 'management', 'project',
  'projects', 'portfolio', 'portfolios', 'task', 'tasks', 'meeting', 'meetings', 'development',
  'system', 'currently', 'recently', 'time', 'entry', 'entries', 'latest', 'based', 'data', 'today',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
]);

const DONE_RE = /^(task completed|completed|approved|ready to go)/i;
const PENDING_STATUSES = new Set(['Not Started', 'Acknowledged', 'For Approval', 'Deployment Pending']);
const ACTIVE_STATUSES = new Set(['working on it', 'In Progress']);

// "Today" (and every calendar-date calculation below) must mean this organization's actual IST
// work day, not whatever timezone the host machine happens to be set to. Confirmed live: this
// Mac's OS timezone is IST (so Node's plain local Date getters accidentally came out right here),
// but PHP's default is UTC (fixed separately in php-mcp/index.php) — proving a host's default
// timezone is not safe to depend on implicitly. Convention used everywhere below: shift the
// relevant instant by this fixed IST offset, then read/write it using *UTC* accessors only —
// those UTC fields then represent IST calendar/clock values, independent of host timezone.
// toRealUnixSeconds() undoes the shift to get back the true Unix timestamp for a range boundary.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const toRealUnixSeconds = (shifted) => Math.floor((shifted.getTime() - IST_OFFSET_MS) / 1000);

/**
 * A record's date fields differ in FORMAT: task/meeting/project dates come from Graph as ISO-8601
 * with an explicit UTC offset, which `new Date()` parses as an absolute instant regardless of host
 * timezone. Time entries store DD/MM/YYYY plain strings ("20/07/2026") with NO timezone information
 * at all — these are calendar dates in this organization's IST work day, so they're parsed via the
 * same UTC-as-IST convention as resolveDateFilter, not the host's local timezone. Never hand a bare
 * DD/MM/YYYY string to a US-month-first parser either (`strtotime`'s PHP equivalent problem applies
 * here too if you used `Date.parse` naively on "05/07/2026").
 * @returns {number|false} unix seconds, or false if unparseable/invalid.
 */
function parseAppDate(raw) {
  if (!raw) return false;
  const m = String(raw).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m.map(Number);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    return d.getUTCFullYear() === yyyy && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd
      ? toRealUnixSeconds(d)
      : false;
  }
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? false : Math.floor(t / 1000);
}

export function resolveStatusFilter(question) {
  const q = String(question || '').toLowerCase();
  if (/\bcompleted\b|\bdone\b|\bfinished\b/.test(q)) return { requested: true, label: 'completed', mode: 'done' };
  if (q.includes('pending')) return { requested: true, label: 'pending', mode: 'pending' };
  if (/\bin progress\b|\bworking on it\b|\bactive\b/.test(q)) return { requested: true, label: 'in progress', mode: 'active' };
  return { requested: false, label: null, mode: null };
}

function statusMatches(status, mode) {
  status = status || '';
  if (mode === 'done') return DONE_RE.test(status);
  if (mode === 'pending') return PENDING_STATUSES.has(status);
  if (mode === 'active') return ACTIVE_STATUSES.has(status);
  return true;
}

export function isOverdueRequested(question) {
  return /\b(overdue|past due|late|behind schedule)\b/i.test(String(question || ''));
}

export function isTaskOverdue(task) {
  if (!task.dueDate) return false;
  const due = parseAppDate(task.dueDate);
  return due !== false && due < Math.floor(Date.now() / 1000) && !DONE_RE.test(task.status || '');
}

/** The field a person's name actually lives in differs by type — meetings have no single-owner
 *  field (only a `participants` list) — not supported here. Exported so callers (count_records'
 *  multi-type loop) can tell whether a type supports person-scoping at all, rather than showing an
 *  unrelated unconstrained count for a type that can't actually be scoped to the requested person. */
export function personField(entityType) {
  if (entityType === 'task' || entityType === 'project' || entityType === 'portfolio') return 'owner';
  if (entityType === 'timeentry') return 'authorName';
  return null;
}

function trimCandidate(raw) {
  const words = raw.trim().split(/\s+/);
  while (words.length > 1 && NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
  if (words.length) words[words.length - 1] = words[words.length - 1].replace(/'s$/i, '');
  return words.join(' ');
}

function isAllStopwords(phrase) {
  return phrase.split(' ').every((w) => !w || NAME_STOPWORDS.has(w.toLowerCase()));
}

/**
 * Matches ONLY against real names actually present in the data, never a fixed list. Fails closed
 * on ambiguity (multiple real people share a first name) rather than silently picking one.
 * @param {string[]} realNames Real owner/author names actually present in the scrolled records.
 */
export function resolvePersonFilter(question, realNames) {
  const q = String(question || '');
  const candidates = [];

  for (const m of q.matchAll(/\b([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,2})\b/gu)) {
    const c = trimCandidate(m[1]);
    if (c && !isAllStopwords(c)) candidates.push(c);
  }
  // Bare single-name fallback ("does Ankush have...") — no adjacent capitalized word for the
  // 2-3-word regex above to include.
  for (const m of q.matchAll(/\b([A-Z][\p{L}'-]+)\b/gu)) {
    const c = trimCandidate(m[1]);
    if (!c || NAME_STOPWORDS.has(c.toLowerCase())) continue;
    const alreadyCovered = candidates.some((existing) => existing.toLowerCase().includes(c.toLowerCase()));
    if (!alreadyCovered) candidates.push(c);
  }

  if (!candidates.length) return { requested: false, resolvedName: null, candidateText: null, ambiguous: null };

  const lowerToReal = new Map(realNames.map((n) => [n.toLowerCase(), n]));

  for (const c of candidates) {
    const exact = lowerToReal.get(c.toLowerCase());
    if (exact) return { requested: true, resolvedName: exact, candidateText: c, ambiguous: null };
  }

  // No exact match — try a looser one (every word of the candidate appears in some real name).
  // Collect EVERY distinct real person a candidate loosely matches; 2+ is genuine ambiguity.
  for (const c of candidates) {
    const cWords = c.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = new Set();
    for (const [lower, real] of lowerToReal) {
      if (cWords.every((w) => lower.includes(w))) matches.add(real);
    }
    const unique = [...matches];
    if (unique.length === 1) return { requested: true, resolvedName: unique[0], candidateText: c, ambiguous: null };
    if (unique.length > 1) return { requested: true, resolvedName: null, candidateText: c, ambiguous: unique };
  }

  return { requested: true, resolvedName: null, candidateText: candidates[0], ambiguous: null };
}

/** Real names actually present in a set of already-fetched records for one type. */
export function collectRealNames(items, entityType) {
  const field = personField(entityType);
  if (!field) return [];
  const names = new Set();
  for (const item of items) {
    const raw = String(item[field] || '').trim();
    if (!raw) continue;
    for (const single of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      names.add(single);
    }
  }
  return [...names];
}

export function unresolvedPersonAnswer(candidateText) {
  return (
    `I couldn't confidently match "${candidateText}" to a real person in the indexed data, so I ` +
    "can't give a scoped answer. Try the exact name as it appears in the data."
  );
}

export function ambiguousPersonAnswer(candidateText, matches) {
  const lines = matches.map((m) => `- ${m}`).join('\n');
  return `"${candidateText}" matches ${matches.length} different people in your data — which one did you mean?\n\n${lines}`;
}

function pickDateField(entityType, question) {
  const q = String(question || '').toLowerCase();
  if (entityType === 'task' && q.includes('due')) return 'dueDate';
  if (entityType === 'timeentry' && q.includes('logged')) return 'timeDate';
  if (entityType === 'meeting') return 'start';
  return 'timestamp'; // Modified||Created — the only "when touched" field project/portfolio have.
}

const nowInIST = () => new Date(Date.now() + IST_OFFSET_MS);

// Explicit ISO day-of-week arithmetic (Monday=1..Sunday=7) — a relative-modify string like "monday
// this week" is not reliable for this; confirmed live on the PHP side it silently produced a far-
// too-wide range (102 of ~152 meetings counted as "last week").
function isoDayOfWeek(date) {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

function weekRange(now, weekOffset) {
  const isoDay = isoDayOfWeek(now);
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - (isoDay - 1) + weekOffset * 7);
  monday.setUTCHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  const label = weekOffset === 0 ? 'this week' : weekOffset < 0 ? 'last week' : 'next week';
  return [toRealUnixSeconds(monday), toRealUnixSeconds(sunday), label];
}

function monthRange(now, monthOffset) {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 0));
  last.setUTCHours(23, 59, 59, 999);
  const label = monthOffset === 0 ? 'this month' : monthOffset < 0 ? 'last month' : 'next month';
  return [toRealUnixSeconds(first), toRealUnixSeconds(last), label];
}

export function resolveDateFilter(question, entityType) {
  const field = pickDateField(entityType, question);
  const q = String(question || '').toLowerCase();

  if (/\b(latest|newest|most recently updated|most recent|last updated)\b/.test(q)) {
    return { requested: true, field, range: null, sortDesc: true, label: 'most recent' };
  }

  const now = nowInIST();
  now.setUTCHours(0, 0, 0, 0);
  let range = null;
  if (q.includes('yesterday')) {
    const y = new Date(now);
    y.setUTCDate(y.getUTCDate() - 1);
    const yEnd = new Date(y);
    yEnd.setUTCHours(23, 59, 59, 999);
    range = [toRealUnixSeconds(y), toRealUnixSeconds(yEnd), 'yesterday'];
  } else if (q.includes('tomorrow')) {
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() + 1);
    const tEnd = new Date(t);
    tEnd.setUTCHours(23, 59, 59, 999);
    range = [toRealUnixSeconds(t), toRealUnixSeconds(tEnd), 'tomorrow'];
  } else if (q.includes('today')) {
    const end = new Date(now);
    end.setUTCHours(23, 59, 59, 999);
    range = [toRealUnixSeconds(now), toRealUnixSeconds(end), 'today'];
  } else if (q.includes('last week')) {
    range = weekRange(now, -1);
  } else if (q.includes('next week')) {
    range = weekRange(now, 1);
  } else if (q.includes('this week')) {
    range = weekRange(now, 0);
  } else if (q.includes('last month')) {
    range = monthRange(now, -1);
  } else if (q.includes('next month')) {
    range = monthRange(now, 1);
  } else if (q.includes('this month')) {
    range = monthRange(now, 0);
  }

  if (!range) {
    // DD/MM/YYYY — this app's locale, never MM/DD. Represented as IST midnight-to-midnight of that
    // calendar date, via the same UTC-as-IST convention as everything else above.
    const m = String(question || '').match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/);
    if (m) {
      const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
      const end = new Date(d);
      end.setUTCHours(23, 59, 59, 999);
      const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      range = [toRealUnixSeconds(d), toRealUnixSeconds(end), label];
    }
  }

  if (!range) return { requested: false, field, range: null, sortDesc: false, label: null };
  return { requested: true, field, range: { start: range[0], end: range[1] }, sortDesc: false, label: range[2] };
}

/** The same business-record identity ingestion itself builds (site+list+item+type). */
function businessEntityKey(payload) {
  if (payload.sourceKey) return payload.sourceKey;
  if (payload.sharePointItemId != null && payload.type) return `${payload.type}:${payload.sharePointItemId}`;
  return null;
}

/** A chunked record (mainly meeting transcripts) must count/list as ONE record, not once per chunk. */
function dedupeBySource(payloads) {
  const bestByKey = new Map();
  const noIdentity = [];
  for (const p of payloads) {
    const key = businessEntityKey(p);
    if (!key) {
      noIdentity.push(p);
      continue;
    }
    const existing = bestByKey.get(key);
    if (!existing || (p.chunkIndex ?? 0) < (existing.chunkIndex ?? 0)) bestByKey.set(key, p);
  }
  return [...noIdentity, ...bestByKey.values()];
}

/** Applies person/status/overdue/date filters, THEN dedupes chunks to real records — filtering
 *  before deduping can't drop a real match (every chunk carries the same metadata). */
export function applyFilters(items, entityType, personFilter, statusFilter, overdueRequested, dateFilter) {
  let out = items;
  const personFieldName = personField(entityType);
  if (personFilter.resolvedName !== null && personFieldName) {
    const target = personFilter.resolvedName;
    out = out.filter((i) => String(i[personFieldName] || '').split(',').some((s) => s.trim() === target));
  }
  if (statusFilter.requested) out = out.filter((i) => statusMatches(i.status, statusFilter.mode));
  if (overdueRequested) out = out.filter((i) => isTaskOverdue(i));
  if (dateFilter.requested && dateFilter.range) {
    const { field } = dateFilter;
    const { start, end } = dateFilter.range;
    out = out.filter((i) => {
      const t = parseAppDate(i[field]);
      return t !== false && t >= start && t <= end;
    });
  }
  return dedupeBySource(out);
}

export function applySort(items, dateFilter) {
  if (!dateFilter.sortDesc) return items;
  const { field } = dateFilter;
  return [...items].sort((a, b) => (parseAppDate(b[field]) || 0) - (parseAppDate(a[field]) || 0));
}

export function buildScopeText(personFilter, statusFilter, overdueRequested, dateFilter) {
  const parts = [];
  if (personFilter.resolvedName !== null) parts.push(`for ${personFilter.resolvedName}`);
  if (statusFilter.requested) parts.push(`status: ${statusFilter.label}`);
  if (overdueRequested) parts.push('overdue');
  if (dateFilter.requested && dateFilter.range) parts.push(`${dateFilter.field} ${dateFilter.label}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
