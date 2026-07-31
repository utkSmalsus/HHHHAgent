const log = document.getElementById('log');
const form = document.getElementById('f');
const input = document.getElementById('q');
const file = document.getElementById('file');
const attachBtn = document.getElementById('attachBtn');
const fileChip = document.getElementById('fileChip');
const fileChipName = document.getElementById('fileChipName');
const fileChipRemove = document.getElementById('fileChipRemove');
const send = document.getElementById('send');
const sendIcon = document.getElementById('sendIcon');
const stopIcon = document.getElementById('stopIcon');
const themeToggle = document.getElementById('themeToggle');

const MAX = 20; // keep last 20 messages; 21st added → oldest dropped, stays 20
let history = [];
try { history = JSON.parse(localStorage.getItem('omt_chat') || '[]'); } catch (e) { history = []; }
function save() {
  history = history.slice(-MAX);
  localStorage.setItem('omt_chat', JSON.stringify(history));
}

// --- theme ---
const iconMoon = document.getElementById('iconMoon');
const iconSun = document.getElementById('iconSun');

// SVG elements are SVGElement, not HTMLElement, so they don't implement the `hidden` IDL
// property — `svg.hidden = true` sets a dead expando and never reaches the [hidden] attribute
// CSS matches on. Always toggle the attribute itself.
function setHidden(el, on) {
  if (on) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  // Show the icon for the mode you'd switch TO.
  setHidden(iconMoon, dark);
  setHidden(iconSun, !dark);
  themeToggle.title = dark ? 'Switch to light' : 'Switch to dark';
  localStorage.setItem('omt_theme', theme);
}
applyTheme(localStorage.getItem('omt_theme') || 'light');
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// --- minimal markdown rendering ---
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
}
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
// Handles fenced ```lang code blocks, "- item" bullets, "| a | b |" tables (with a "|---|---|"
// separator row skipped), "**bold**", and `inline code` — the full subset the deterministic
// formatters (bullets/table/timeline) plus typical LLM output use; everything else is plain text.
function markdownLite(text) {
  const lines = String(text || '').split('\n');
  let html = '';
  let inList = false;
  let tableRows = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  const flushList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const flushTable = () => {
    if (!tableRows.length) return;
    html += '<table class="mtable">' + tableRows.map((cells, i) =>
      '<tr>' + cells.map((c) => (i === 0 ? '<th>' : '<td>') + inlineMd(c.trim()) + (i === 0 ? '</th>' : '</td>')).join('') + '</tr>'
    ).join('') + '</table>';
    tableRows = [];
  };
  const flushCode = () => {
    html +=
      '<div class="code-block"><div class="code-header"><span class="code-lang">' +
      escapeHtml(codeLang || 'text') +
      '</span><button type="button" class="copy-btn">' + COPY_ICON + '<span>Copy</span></button></div>' +
      '<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre></div>';
    codeLines = [];
    codeLang = '';
  };
  for (const line of lines) {
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushList();
        flushTable();
        inCode = true;
        codeLang = fence[1] || '';
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const bullet = line.match(/^[-•]\s+(.*)/);
    const tableLine = line.trim().match(/^\|(.+)\|$/);
    const isSeparatorRow = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
    if (tableLine && !isSeparatorRow) {
      flushList();
      tableRows.push(tableLine[1].split('|'));
      continue;
    }
    if (isSeparatorRow && tableRows.length) continue;
    flushTable();
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inlineMd(bullet[1]) + '</li>';
      continue;
    }
    flushList();
    if (line.trim()) html += '<div>' + inlineMd(line) + '</div>';
  }
  if (inCode) flushCode(); // unterminated fence (still streaming) — render what we have so far
  flushList();
  flushTable();
  return html;
}

// Copy-to-clipboard for rendered code blocks. Buttons are recreated on every innerHTML write
// (typewriter re-renders each tick), so this just needs calling after each write — no dedup guard.
function wireCodeBlocks(root) {
  root.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.onclick = () => {
      const code = btn.closest('.code-block')?.querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.classList.add('copied');
        const label = btn.querySelector('span');
        const prev = label.textContent;
        label.textContent = 'Copied!';
        setTimeout(() => { label.textContent = prev; btn.classList.remove('copied'); }, 1500);
      }).catch(() => {});
    };
  });
}

// --- citations ---
function normalizeSources(list) {
  return (list || []).slice(0, 15).map((s) => {
    const p = s.payload || s;
    return { title: p.title || 'Untitled', type: p.type || p.itemType || '', date: (p.timestamp || p.start || '').slice(0, 10) };
  });
}
function renderSources(sources) {
  if (!sources || !sources.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'sources';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'sources-toggle';
  const label = (open) => (open ? '▾ ' : '▸ ') + sources.length + ' source' + (sources.length === 1 ? '' : 's');
  toggle.textContent = label(false);
  const list = document.createElement('div');
  list.className = 'sources-list';
  list.style.display = 'none';
  sources.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'source-item';
    const titleEl = document.createElement('span');
    titleEl.className = 'src-title';
    titleEl.textContent = s.title;
    row.appendChild(titleEl);
    const metaBits = [s.type, s.date].filter(Boolean).join(' · ');
    if (metaBits) {
      const metaEl = document.createElement('span');
      metaEl.className = 'src-meta';
      metaEl.textContent = metaBits;
      row.appendChild(metaEl);
    }
    list.appendChild(row);
  });
  let open = false;
  toggle.addEventListener('click', () => {
    open = !open;
    list.style.display = open ? 'block' : 'none';
    toggle.textContent = label(open);
  });
  wrap.appendChild(toggle);
  wrap.appendChild(list);
  return wrap;
}

// --- empty state ---
const EXAMPLES = [
  "What's the latest work on Team Management Tool?",
  'Show me overdue tasks as a table',
  'What meetings happened this week?',
  'List open tasks in bullet points',
];
function showEmptyState() {
  log.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.id = 'emptyState';
  const title = document.createElement('div');
  title.className = 'empty-title';
  title.textContent = 'Ask about your projects, tasks, and meetings';
  wrap.appendChild(title);
  const examples = document.createElement('div');
  examples.className = 'examples';
  EXAMPLES.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'example';
    b.textContent = q;
    b.addEventListener('click', () => {
      input.value = q;
      form.requestSubmit();
    });
    examples.appendChild(b);
  });
  wrap.appendChild(examples);
  log.appendChild(wrap);
}
function hideEmptyStateIfPresent() {
  const el = document.getElementById('emptyState');
  if (el) el.remove();
}

// Disambiguation follow-ups ("did you mean X or Y?") — clicking one re-asks with that exact
// name, which resolves unambiguously since it now matches only one real entity.
function renderSuggestions(suggestions) {
  if (!suggestions || !suggestions.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'examples suggestions-row';
  suggestions.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'example';
    b.textContent = s.label || s.question;
    b.addEventListener('click', () => {
      input.value = s.question;
      form.requestSubmit();
    });
    wrap.appendChild(b);
  });
  return wrap;
}

function render(text, cls, meta, sources, suggestions) {
  hideEmptyStateIfPresent();
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.innerHTML = markdownLite(text);
  wireCodeBlocks(el);
  if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; el.appendChild(m); }
  const srcEl = renderSources(sources);
  if (srcEl) el.appendChild(srcEl);
  const sugEl = renderSuggestions(suggestions);
  if (sugEl) el.appendChild(sugEl);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// Word-by-word reveal for freshly-generated prose answers — deterministic formatter output
// (tables/bullets/timeline) already IS the final data, so that renders instantly instead.
function typewriter(el, text) {
  return new Promise((resolve) => {
    const tokens = text.split(/(\s+)/).filter((t) => t !== '');
    if (tokens.length <= 1) { el.innerHTML = markdownLite(text); wireCodeBlocks(el); resolve(); return; }
    const chunk = Math.max(1, Math.ceil(tokens.length / 50));
    let i = 0;
    function tick() {
      i = Math.min(tokens.length, i + chunk);
      el.innerHTML = markdownLite(tokens.slice(0, i).join(''));
      log.scrollTop = log.scrollHeight;
      if (i < tokens.length) setTimeout(tick, 20);
      else { wireCodeBlocks(el); resolve(); }
    }
    tick();
  });
}

function cleanDisplayText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
input.addEventListener('input', autoResize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function setAttachedFile(picked) {
  attachBtn.classList.toggle('has-file', Boolean(picked));
  fileChip.hidden = !picked;
  fileChipName.textContent = picked ? picked.name : '';
  input.placeholder = picked ? 'Optional note for this transcript…' : 'Ask about projects, tasks, meetings…';
}

attachBtn.addEventListener('click', () => file.click());
file.addEventListener('change', () => {
  setAttachedFile(file.files[0]);
  input.focus();
});
fileChipRemove.addEventListener('click', () => {
  file.value = '';
  setAttachedFile(null);
  input.focus();
});

// Restore saved conversation on load, or show the empty state for a fresh chat.
if (history.length) {
  history.forEach((m) => render(m.text, m.role === 'user' ? 'user' : 'bot', m.meta, m.sources, m.suggestions));
} else {
  showEmptyState();
}

// New Chat: wipe history + context and start fresh.
document.getElementById('newchat').addEventListener('click', () => {
  history = [];
  localStorage.removeItem('omt_chat');
  showEmptyState();
  input.focus();
});

let inFlight = null; // AbortController for the current request, or null when idle

function setSendMode(mode) {
  // 'send' | 'stop' — the button doubles as Stop while a request is in flight.
  const stopping = mode === 'stop';
  setHidden(sendIcon, stopping);
  setHidden(stopIcon, !stopping);
  send.classList.toggle('stopping', stopping);
  send.title = stopping ? 'Stop' : 'Send';
  send.setAttribute('aria-label', stopping ? 'Stop' : 'Send');
}

send.addEventListener('click', (e) => {
  if (inFlight) {
    e.preventDefault();
    inFlight.abort();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (inFlight) return; // mid-request: the click above is a Stop, not a new Send
  const question = input.value.trim();
  const pickedFile = file.files[0];
  if (!question && !pickedFile) return;
  const priorHistory = history.slice(-10); // conversation so far, before this question
  const shownUserText = pickedFile
    ? 'Uploaded transcript: ' + pickedFile.name + (question ? '\n' + question : '')
    : question;
  render(shownUserText, 'user');
  history.push({ role: 'user', text: shownUserText }); save();
  input.value = '';
  autoResize();
  attachBtn.disabled = true;
  setSendMode('stop');
  const controller = new AbortController();
  inFlight = controller;
  const thinking = render('Thinking', 'bot loading typing-dots'); // transient, not saved until answered
  try {
    let r;
    if (pickedFile) {
      const fd = new FormData();
      fd.append('file', pickedFile);
      if (question) fd.append('question', question);
      r = await fetch('/api/meetings/analyze', { method: 'POST', body: fd, signal: controller.signal });
    } else {
      r = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: priorHistory }),
        signal: controller.signal,
      });
    }
    const data = await r.json();
    if (data.success) {
      const rawSources = pickedFile ? null : data.sources?.qdrant;
      const sources = normalizeSources(rawSources);
      const srcCount = pickedFile
        ? ((data.sources?.meetings || []).length + (data.sources?.tasks || []).length)
        : sources.length;
      const text = cleanDisplayText(data.answer) || '(no answer)';
      const meta = pickedFile
        ? 'transcript analysis · ' + (data.retrieved?.meetings || 0) + ' meeting sources · ' + (data.retrieved?.tasks || 0) + ' task sources'
        : 'intent: ' + (data.intent || '?') + ' · format: ' + (data.format || 'prose') + ' · confidence: ' + (data.confidence ?? '?') + ' · ' + srcCount + ' sources';

      thinking.classList.remove('loading', 'typing-dots');
      thinking.textContent = '';
      const isProse = !pickedFile && (!data.format || data.format === 'prose');
      if (isProse) await typewriter(thinking, text);
      else { thinking.innerHTML = markdownLite(text); wireCodeBlocks(thinking); }

      const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; thinking.appendChild(m);
      const srcEl = renderSources(sources);
      if (srcEl) thinking.appendChild(srcEl);
      const suggestions = pickedFile ? null : data.suggestions || null;
      const sugEl = renderSuggestions(suggestions);
      if (sugEl) thinking.appendChild(sugEl);
      log.scrollTop = log.scrollHeight;

      history.push({ role: 'bot', text, meta, sources, suggestions }); save();
      if (pickedFile) {
        file.value = '';
        setAttachedFile(null);
      }
    } else {
      const text = 'Error: ' + (data.error || 'unknown');
      thinking.classList.remove('loading', 'typing-dots');
      thinking.classList.add('error');
      thinking.textContent = text;
      history.push({ role: 'bot', text }); save();
    }
  } catch (err) {
    thinking.classList.remove('loading', 'typing-dots');
    if (err.name === 'AbortError') {
      thinking.textContent = 'Stopped.';
    } else {
      thinking.classList.add('error');
      thinking.textContent = 'Request failed: ' + err.message;
    }
  } finally {
    inFlight = null;
    setSendMode('send');
    attachBtn.disabled = false;
    input.focus();
  }
});
