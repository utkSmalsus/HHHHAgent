const LIST_LABELS = {
  portfolio: 'Portfolio',
  projects: 'Projects',
  tasks: 'Tasks',
  timeentries: 'Time Entries',
  meetings: 'Meetings + Transcripts',
};
const LIST_ORDER = ['portfolio', 'projects', 'tasks', 'timeentries', 'meetings'];

const themeToggle = document.getElementById('themeToggle');
const summaryPct = document.getElementById('summaryPct');
const summaryMsg = document.getElementById('summaryMsg');
const summaryBar = document.getElementById('summaryBar');
const summaryMeta = document.getElementById('summaryMeta');
const grid = document.getElementById('grid');
const fullIngestBtn = document.getElementById('fullIngest');
const stopBtn = document.getElementById('stopBtn');

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

const cardEls = {};
function buildCards() {
  grid.innerHTML = '';
  LIST_ORDER.forEach((key) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="card-top"><span class="card-name">' + LIST_LABELS[key] + '</span><span class="badge" data-badge>pending</span></div>' +
      '<div class="bar-wrap"><div class="bar-fill" data-bar></div></div>' +
      '<div class="card-counts"><span data-counts>0 / 0</span><span data-pct>0%</span></div>' +
      '<button type="button" data-ingest-btn>Ingest ' + LIST_LABELS[key] + '</button>';
    grid.appendChild(card);
    const btn = card.querySelector('[data-ingest-btn]');
    btn.addEventListener('click', () => runIngest(key, btn));
    cardEls[key] = {
      badge: card.querySelector('[data-badge]'),
      bar: card.querySelector('[data-bar]'),
      counts: card.querySelector('[data-counts]'),
      pct: card.querySelector('[data-pct]'),
      btn,
    };
  });
}
buildCards();

async function runIngest(key, btn) {
  btn.disabled = true;
  const res = await fetch('/api/ingest/' + key, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    summaryMsg.textContent = 'Error: ' + (err.error || res.status);
    btn.disabled = false;
  }
}

fullIngestBtn.addEventListener('click', async () => {
  fullIngestBtn.disabled = true;
  const res = await fetch('/api/ingest/all', { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    summaryMsg.textContent = 'Error: ' + (err.error || res.status);
    fullIngestBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  await fetch('/api/ingest/stop', { method: 'POST' }).catch(() => {});
});

function update(p) {
  const running = p.status === 'running';
  summaryPct.textContent = p.percent + '%';
  summaryMsg.textContent = p.message || '';
  summaryBar.style.width = p.percent + '%';
  summaryBar.classList.toggle('done', p.status === 'completed');
  summaryBar.classList.toggle('cancelled', p.status === 'cancelled' || p.status === 'failed');
  summaryMeta.textContent = running
    ? p.processed + '/' + p.total + ' items · ' + p.elapsedSec + 's elapsed'
    : p.status + (p.elapsedSec ? ' · ' + p.elapsedSec + 's' : '');

  const buttons = grid.querySelectorAll('[data-ingest-btn]');
  buttons.forEach((b) => { b.disabled = running; });
  fullIngestBtn.disabled = running;
  stopBtn.disabled = !running;

  LIST_ORDER.forEach((key) => {
    const el = cardEls[key];
    const list = (p.lists || {})[key];
    if (!list) {
      el.badge.textContent = 'pending';
      el.badge.className = 'badge';
      el.bar.style.width = '0%';
      el.counts.textContent = '0 / 0';
      el.pct.textContent = '0%';
      return;
    }
    el.badge.textContent = list.status;
    el.badge.className = 'badge ' + list.status;
    el.bar.style.width = (list.percent || 0) + '%';
    el.bar.classList.toggle('done', list.status === 'done');
    el.counts.textContent = (list.ingested || 0) + ' / ' + (list.fetched || '?');
    el.pct.textContent = (list.percent || 0) + '%';
  });
}

const es = new EventSource('/api/ingest/progress/stream');
es.onmessage = (e) => update(JSON.parse(e.data));
