import { getTeamsAccessToken } from './teamsAuth.js';

/**
 * EOD reports posted into a handful of known Teams group chats — ingested as their own record
 * type ('eodreport') so a developer's end-of-day update surfaces in answers even when they never
 * updated the task's own EOD field. No project/task matching logic here: EOD reports already name
 * their project in a "Focus:" line or section headers (see the real example this was built from),
 * so the existing keyword/semantic search picks them up like any other record — this file's only
 * job is getting the raw message text into Qdrant.
 *
 * Chat ids come from Teams' own "Copy link to chat" (the id in the URL) — `teams_list_chats`-style
 * discovery by NAME doesn't reliably find every group (a chat's UI display name can be a personal
 * rename that never appears in the shared `topic` field the Graph API returns).
 */
const EOD_CHATS = [
  { id: '19:8eaf907d84bb455cbee5bf04fdf6edef@thread.v2', name: 'SPA Core Internal Group' },
  { id: '19:dd9418f7f2be43cfac827d455baee36a@thread.v2', name: 'AI Core Group' },
  { id: '19:f70e0fcb10d844f79dd08b9af92e9e4c@thread.v2', name: 'Meeting Tool Core Group' },
];

const MAX_PAGES_PER_CHAT = 10; // safety cap: 10 * 50 = 500 messages/chat/run, far above any real daily volume.

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchChatMessages(token, chatId) {
  const messages = [];
  let url = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages?$top=50`;
  for (let page = 0; page < MAX_PAGES_PER_CHAT && url; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Teams chat fetch failed (${chatId}): ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    messages.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return messages;
}

function messageToKnowledge(message, chat) {
  const text = stripHtml(message.body?.content);
  if (!text) return null;
  const authorName = message.from?.user?.displayName || 'Unknown';
  return {
    text: `${authorName} — ${chat.name}. ${text}`,
    metadata: {
      type: 'eodreport',
      title: `${authorName} — EOD — ${String(message.createdDateTime || '').slice(0, 10)}`,
      authorName,
      chatId: chat.id,
      chatName: chat.name,
      sharePointItemId: message.id,
      timestamp: message.createdDateTime,
    },
    structured: { id: message.id, authorName, chatId: chat.id, createdDateTime: message.createdDateTime },
  };
}

/**
 * @param {{modifiedSince?: string}} options ISO timestamp — only messages created after this are
 *   ingested. Omit for a first/full run (still capped by MAX_PAGES_PER_CHAT, not unbounded).
 */
export async function fetchEodReports({ modifiedSince } = {}) {
  const token = await getTeamsAccessToken();
  if (!token) {
    return { items: [], structured: [], configured: false };
  }

  const since = modifiedSince ? new Date(modifiedSince).getTime() : 0;
  const items = [];
  const sources = [];

  for (const chat of EOD_CHATS) {
    let messages;
    try {
      messages = await fetchChatMessages(token, chat.id);
    } catch (err) {
      console.warn(`EOD ingest skip [${chat.name}]:`, err.message);
      sources.push({ chatId: chat.id, chatName: chat.name, error: err.message });
      continue;
    }
    const real = messages.filter((m) => m.messageType === 'message' && !m.deletedDateTime);
    const fresh = real.filter((m) => new Date(m.createdDateTime).getTime() > since);
    const parsed = fresh.map((m) => messageToKnowledge(m, chat)).filter(Boolean);
    items.push(...parsed);
    sources.push({ chatId: chat.id, chatName: chat.name, fetched: real.length, ingested: parsed.length });
  }

  return { items, structured: items.map((i) => i.structured), configured: true, sources };
}
