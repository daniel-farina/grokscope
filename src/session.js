// Session detail page - per-session live stats, files, git history.

import {
  $, PAGE_SIZE, fmtNum, fmtBytes, fmtAgo, truncMid, copyText,
  buildPager, renderBars, renderSpark, setLive,
  loadSidebarSessions, setActiveSidebarId, wireSidebar,
} from './common.js';

const HISTORY_MAX = 60;

const state = {
  activeId: null,
  evtSource: null,
  lastEventAt: 0,
  pages: { edits: 0, captures: 0, usage: 0, files: 0, git: 0 },
  captures: [],
  files: { cwd: null, list: [] },
  git: { info: null },
  history: { tokens: [], loc: [], tools: [], cost: [], turns: [] },
  lastStats: null,
};

// ---------- captures ----------

async function loadCaptures() {
  try {
    const r = await fetch('/api/captures');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.captures = await r.json();
    renderCaptures();
  } catch (e) {
    $('captures').textContent = 'error: ' + e.message;
  }
}

function renderCaptures() {
  const root = $('captures');
  const pagerEl = $('captures-pager');
  root.innerHTML = '';
  pagerEl.innerHTML = '';
  const rows = state.captures;
  if (!rows.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no captures yet. start grokscope-tap to record HTTP traffic.';
    root.appendChild(d);
    return;
  }
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  state.pages.captures = Math.min(state.pages.captures, pages - 1);
  const start = state.pages.captures * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);

  for (const r of slice) {
    const row = document.createElement('div');
    row.className = 'capt-row';
    const status = Number(r.status || 0);
    const statusClass = status >= 200 && status < 400 ? 'status-ok' : 'status-bad';
    row.innerHTML = `
      <span class="capt-ts">${r.ts || ''}</span>
      <span class="capt-method">${r.method || ''}</span>
      <span class="path" title="${r.path || ''}">${r.path || ''}</span>
      <span class="${statusClass}">${r.status ?? '-'}</span>
      <span class="muted">${r.elapsed_ms ?? '-'}ms</span>
      <span class="muted">${fmtBytes(r.resp_bytes)}</span>
    `;
    root.appendChild(row);
  }
  pagerEl.append(...buildPager(state.pages.captures, pages, (p) => {
    state.pages.captures = p;
    renderCaptures();
  }, rows.length));
}

// ---------- files + git ----------

async function loadFiles() {
  if (!state.activeId) return;
  try {
    const r = await fetch(`/api/session/${state.activeId}/files`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    state.files = { cwd: d.cwd, list: d.files || [] };
    state.pages.files = 0;
    renderFiles();
  } catch (e) {
    $('files-list').textContent = 'error: ' + e.message;
  }
}

function renderFiles() {
  const root = $('files-list');
  const pagerEl = $('files-pager');
  root.innerHTML = '';
  pagerEl.innerHTML = '';
  const list = state.files.list;
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = state.files.cwd ? 'no files (cwd may not exist)' : 'select a session';
    root.appendChild(d);
    return;
  }
  const pages = Math.ceil(list.length / PAGE_SIZE);
  state.pages.files = Math.min(state.pages.files, pages - 1);
  const start = state.pages.files * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);
  for (const f of slice) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `
      <span class="file-ext">.${f.ext}</span>
      <span class="path" title="${f.path}">${f.path}</span>
      <span class="muted">${fmtBytes(f.size)}</span>
      <span class="when">${fmtAgo(f.mtime / 1000)}</span>
    `;
    root.appendChild(row);
  }
  pagerEl.append(...buildPager(state.pages.files, pages, (p) => {
    state.pages.files = p;
    renderFiles();
  }, list.length));
}

async function loadGit() {
  if (!state.activeId) return;
  try {
    const r = await fetch(`/api/session/${state.activeId}/git`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.git = { info: await r.json() };
    state.pages.git = 0;
    renderGit();
  } catch (e) {
    $('git-list').textContent = 'error: ' + e.message;
  }
}

function renderGit() {
  const root = $('git-list');
  const pagerEl = $('git-pager');
  const branchEl = $('git-branch');
  root.innerHTML = '';
  pagerEl.innerHTML = '';
  branchEl.textContent = '';
  const info = state.git.info;
  if (!info || !info.exists) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'cwd does not exist';
    root.appendChild(d);
    return;
  }
  if (!info.is_repo) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'not a git repo';
    root.appendChild(d);
    return;
  }
  if (info.branch) branchEl.textContent = info.branch + (info.dirty_count ? ' · ' + info.dirty_count + ' dirty' : '');
  const commits = info.commits || [];
  if (!commits.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no commits';
    root.appendChild(d);
    return;
  }
  const pages = Math.ceil(commits.length / PAGE_SIZE);
  state.pages.git = Math.min(state.pages.git, pages - 1);
  const start = state.pages.git * PAGE_SIZE;
  const slice = commits.slice(start, start + PAGE_SIZE);
  for (const c of slice) {
    const row = document.createElement('div');
    row.className = 'commit-row';
    const stat = c.stat || { files: 0, insertions: 0, deletions: 0 };
    row.innerHTML = `
      <span class="commit-sha">${c.sha}</span>
      <span class="commit-msg" title="${c.subject}">${c.subject}</span>
      <span class="commit-stat"><span class="added">+${stat.insertions}</span><span class="removed">-${stat.deletions}</span></span>
      <span class="when">${fmtAgo(Date.parse(c.date) / 1000)}</span>
    `;
    root.appendChild(row);
  }
  pagerEl.append(...buildPager(state.pages.git, pages, (p) => {
    state.pages.git = p;
    renderGit();
  }, commits.length));
}

// ---------- stats ----------

function pushHistory(key, value) {
  const arr = state.history[key];
  arr.push(value);
  if (arr.length > HISTORY_MAX) arr.shift();
}

function renderUsageChart(calls) {
  const root = $('usage-chart');
  const pagerEl = $('usage-pager');
  if (!root) return;
  root.innerHTML = '';
  pagerEl.innerHTML = '';
  if (!calls.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = 'no captured API calls for this session. enable the tap by adding <code>base_url = "http://127.0.0.1:18080/v1"</code> under <code>[model.grok-build]</code> in <code>~/.grok/config.toml</code>.';
    root.appendChild(d);
    return;
  }
  const totalIn = calls.reduce((s, c) => s + c.input, 0);
  const totalOut = calls.reduce((s, c) => s + c.output, 0);

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = `
    <span class="leg in"><i></i> input (${fmtNum(totalIn)})</span>
    <span class="leg out"><i></i> output (${fmtNum(totalOut)})</span>
    <span class="leg reason"><i></i> reasoning portion</span>
    <span class="leg cached"><i></i> cached input portion</span>
  `;
  root.appendChild(legend);

  const pages = Math.ceil(calls.length / PAGE_SIZE);
  state.pages.usage = Math.min(state.pages.usage, pages - 1);
  const start = state.pages.usage * PAGE_SIZE;
  const slice = calls.slice(start, start + PAGE_SIZE);
  const maxTotal = Math.max(...calls.map((c) => c.input + c.output), 1);

  const list = document.createElement('div');
  list.className = 'chart-bars';
  slice.forEach((c, i) => {
    const idx = start + i + 1;
    const row = document.createElement('div');
    row.className = 'chart-row';
    const inPctOfMax = Math.round((c.input / maxTotal) * 100);
    const outPctOfMax = Math.round((c.output / maxTotal) * 100);
    const reasonPct = c.output ? Math.round((c.reasoning / c.output) * 100) : 0;
    const cachedPct = c.input ? Math.round((c.cached / c.input) * 100) : 0;
    row.innerHTML = `
      <span class="chart-idx">#${idx}</span>
      <div class="chart-stack" title="in ${fmtNum(c.input)} (cached ${fmtNum(c.cached)}) · out ${fmtNum(c.output)} (reasoning ${fmtNum(c.reasoning)})">
        <div class="seg seg-in" style="width:${inPctOfMax}%">
          <div class="seg-cached" style="width:${cachedPct}%"></div>
        </div>
        <div class="seg seg-out" style="width:${outPctOfMax}%">
          <div class="seg-reason" style="width:${reasonPct}%"></div>
        </div>
      </div>
      <span class="chart-val"><span class="usage-in">${fmtNum(c.input)}</span> / <span class="usage-out">${fmtNum(c.output)}</span></span>
    `;
    list.appendChild(row);
  });
  root.appendChild(list);
  pagerEl.append(...buildPager(state.pages.usage, pages, (p) => {
    state.pages.usage = p;
    renderUsageChart(calls);
  }, calls.length));
}

function renderRecentEdits(edits) {
  const root = $('recent-edits');
  const pagerEl = $('edits-pager');
  root.innerHTML = '';
  pagerEl.innerHTML = '';
  if (!edits.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no edits yet';
    root.appendChild(d);
    return;
  }
  const pages = Math.ceil(edits.length / PAGE_SIZE);
  state.pages.edits = Math.min(state.pages.edits, pages - 1);
  const start = state.pages.edits * PAGE_SIZE;
  const slice = edits.slice(start, start + PAGE_SIZE);
  for (const e of slice) {
    const row = document.createElement('div');
    row.className = 'row-item';
    const filename = (e.filePath || '').split('/').pop() || '?';
    const added = Number(e.linesAdded || 0);
    const sign = added >= 0 ? '+' : '';
    const cls = added >= 0 ? 'added' : 'removed';
    row.innerHTML = `
      <span class="path" title="${e.filePath || ''}">${filename}</span>
      <span class="${cls}">${sign}${fmtNum(added)}</span>
      <span class="when">${fmtAgo(e.timestamp)}</span>
    `;
    root.appendChild(row);
  }
  pagerEl.append(...buildPager(state.pages.edits, pages, (p) => {
    state.pages.edits = p;
    renderRecentEdits(edits);
  }, edits.length));
}

function renderStats(stats) {
  if (!stats) return;
  state.lastStats = stats;
  const m = stats.meta || {};
  const tk = stats.tokens || {};
  const lc = stats.loc || {};
  const fl = stats.flow || {};
  const tools = stats.tools || [];
  const us = stats.usage || {};

  state.activeId = m.id;
  state.lastEventAt = Date.now();

  $('session-title').textContent = m.title || '(untitled)';
  $('session-model').textContent = m.model || '?';
  const cwd = m.cwd || '';
  const cwdEl = $('session-cwd');
  cwdEl.textContent = cwd;
  cwdEl.title = cwd;
  $('copy-cwd').dataset.copy = cwd;
  $('foot-session').textContent = m.id || '-';
  $('foot-last-event').textContent = fmtAgo(fl.last_event_ts);

  const tokensTotal = tk.last_total_tokens || 0;
  const locTotal = lc.lines_added || 0;
  const toolsTotal = fl.tools_started || 0;
  const costTotal = us.cost_usd || 0;
  const turnsTotal = fl.turns_started || 0;

  const prev = {
    loc: state.history.loc.at(-1) || 0,
    tools: state.history.tools.at(-1) || 0,
  };

  pushHistory('tokens', tokensTotal);
  pushHistory('loc', locTotal);
  pushHistory('tools', toolsTotal);
  pushHistory('cost', costTotal);
  pushHistory('turns', turnsTotal);

  $('m-tokens').textContent = fmtNum(tokensTotal);
  $('m-token-rate').textContent = (tk.tokens_per_sec || 0).toFixed(1);
  $('m-loc').textContent = fmtNum(locTotal);
  const dLoc = locTotal - prev.loc;
  $('m-loc-delta').textContent = (dLoc >= 0 ? '+' : '') + fmtNum(dLoc);
  $('m-tools').textContent = fmtNum(toolsTotal);
  const dTools = toolsTotal - prev.tools;
  $('m-tool-delta').textContent = (dTools >= 0 ? '+' : '') + fmtNum(dTools);
  $('m-turns').textContent = fmtNum(turnsTotal);
  $('m-turn-errors').textContent = `${fmtNum(fl.turns_error || 0)} err`;

  renderSpark($('spark-tokens'), state.history.tokens, '#5eead4');
  renderSpark($('spark-loc'), state.history.loc, '#86efac');
  renderSpark($('spark-tools'), state.history.tools, '#c4b5fd');
  renderSpark($('spark-turns'), state.history.turns, '#f9a8d4');

  $('card-tokens').textContent = fmtNum(tk.last_total_tokens);
  $('card-tps').textContent = (tk.tokens_per_sec || 0).toFixed(2);
  $('card-peak').textContent = fmtNum(tk.peak_total_tokens);
  $('card-added').textContent = '+' + fmtNum(lc.lines_added);
  $('card-removed').textContent = '-' + fmtNum(lc.lines_removed);
  const net = lc.net_added - lc.net_removed;
  $('card-net').textContent = (net >= 0 ? '+' : '') + fmtNum(net);
  $('card-net-removed').textContent = '-' + fmtNum(lc.net_removed);

  $('card-files').textContent = fmtNum(lc.files_touched);
  const extSummary = (lc.by_ext || [])
    .slice(0, 3)
    .map((e) => `${e.ext} ${fmtNum(e.lines)}`)
    .join(' · ');
  $('card-files-sub').textContent = extSummary || '-';

  $('card-turns-started').textContent = fmtNum(fl.turns_started);
  $('card-turns-ended').textContent = fmtNum(fl.turns_ended);
  $('card-turns-error').textContent = fmtNum(fl.turns_error);
  $('card-perms').textContent = fmtNum(fl.permission_prompts);

  $('card-tools-started').textContent = fmtNum(fl.tools_started);
  $('card-tools-completed').textContent = fmtNum(fl.tools_completed);
  $('card-current-tool').textContent = fl.current_tool || 'idle';

  $('card-usage-in').textContent = fmtNum(us.input_tokens || 0);
  $('card-usage-out').textContent = fmtNum(us.output_tokens || 0);
  $('card-usage-calls').textContent = fmtNum(us.calls || 0);
  $('card-usage-cached').textContent = fmtNum(us.cached_tokens || 0);
  // (api cost intentionally not displayed - removed from UI)

  renderUsageChart(us.per_call || []);
  renderBars($('tool-bars'), tools.slice(0, 12).map((t) => ({ name: t.name, value: t.count })));
  renderBars(
    $('ext-bars'),
    (lc.by_ext || []).map((e) => ({ name: '.' + e.ext, value: e.lines })),
  );

  renderRecentEdits(lc.recent_edits || []);
  setActiveSidebarId(m.id);
}

function restartStream() {
  if (state.evtSource) {
    state.evtSource.close();
    state.evtSource = null;
  }
  const url = state.activeId
    ? `/api/stream?id=${encodeURIComponent(state.activeId)}`
    : '/api/stream';
  const es = new EventSource(url);
  state.evtSource = es;
  setLive(false, 'connecting');
  es.onopen = () => setLive(true, 'live');
  es.onerror = () => setLive(false, 'reconnecting');
  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.type === 'stats') {
        renderStats(data.stats);
        setLive(true, 'live');
      } else if (data.type === 'no_session') {
        setLive(false, 'idle');
      }
    } catch {}
  };
}

function getSessionIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id');
}

async function init() {
  state.activeId = getSessionIdFromUrl();
  if (state.activeId) setActiveSidebarId(state.activeId);

  wireSidebar({
    onSelect: (id) => {
      state.activeId = id;
      state.history = { tokens: [], loc: [], tools: [], cost: [], turns: [] };
      const url = new URL(window.location.href);
      url.searchParams.set('id', id);
      window.history.replaceState({}, '', url.toString());
      restartStream();
      loadFiles();
      loadGit();
    },
  });

  $('copy-cwd')?.addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    const path = btn.dataset.copy || '';
    if (path) copyText(path, btn);
  });

  await Promise.all([loadSidebarSessions(), loadCaptures()]);
  if (state.activeId) {
    loadFiles();
    loadGit();
  }
  restartStream();
  setInterval(loadSidebarSessions, 5000);
  setInterval(loadCaptures, 5000);
  setInterval(() => {
    if (state.activeId) {
      loadFiles();
      loadGit();
    }
  }, 10000);
  setInterval(() => {
    if (state.lastEventAt && Date.now() - state.lastEventAt > 4000) {
      setLive(false, 'stale');
    }
  }, 1000);
}

init();
