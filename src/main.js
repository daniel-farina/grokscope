// grokscope frontend - vanilla JS.

const $ = (id) => document.getElementById(id);

const HISTORY_MAX = 60; // sparkline buffer length (60s at 1 Hz)
const PAGE_SIZE = 10;

const state = {
  view: 'overview', // 'overview' | 'session'
  sessions: [],
  activeId: null,
  pinned: false,
  evtSource: null,
  lastEventAt: 0,
  search: '',
  pages: { edits: 0, captures: 0, usage: 0, files: 0, git: 0 },
  captures: [],
  files: { cwd: null, list: [] },
  git: { cwd: null, info: null },
  collapsed: new Set(),
  history: {
    tokens: [],
    loc: [],
    tools: [],
    cost: [],
    turns: [],
  },
  lastStats: null,
  overview: null,
};

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '0';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1) + 'k';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'k';
  return Math.round(n).toLocaleString();
}

function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  return (n / 1024 / 1024).toFixed(2) + 'M';
}

function fmtAgo(epochS) {
  if (!epochS) return '-';
  const ms = typeof epochS === 'number' ? epochS * 1000 : Date.parse(epochS);
  if (!Number.isFinite(ms)) return '-';
  const diff = Math.max(0, (Date.now() - ms) / 1000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncMid(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  const keep = max - 3;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + '...' + s.slice(-tail);
}

function pushHistory(key, value) {
  const arr = state.history[key];
  arr.push(value);
  if (arr.length > HISTORY_MAX) arr.shift();
}

function renderSpark(svgId, data, accent) {
  const svg = $(svgId);
  if (!svg) return;
  svg.innerHTML = '';
  if (!data.length) return;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = Math.max(1, max - min);
  const w = 100, h = 30, pad = 1.5;
  const usableH = h - pad * 2;
  const step = data.length > 1 ? w / (data.length - 1) : w;

  const points = data.map((v, i) => {
    const x = i * step;
    const y = pad + usableH - ((v - min) / range) * usableH;
    return [x, y];
  });

  // Area fill
  let area = `M ${points[0][0]} ${h} `;
  for (const [x, y] of points) area += `L ${x} ${y} `;
  area += `L ${points[points.length - 1][0]} ${h} Z`;

  // Line
  let line = `M ${points[0][0]} ${points[0][1]} `;
  for (let i = 1; i < points.length; i++) line += `L ${points[i][0]} ${points[i][1]} `;

  const ns = 'http://www.w3.org/2000/svg';
  const gradId = svgId + '-grad';
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.35" />
        <stop offset="100%" stop-color="${accent}" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#${gradId})" />
    <path d="${line}" fill="none" stroke="${accent}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="${points[points.length - 1][0]}" cy="${points[points.length - 1][1]}" r="1.8" fill="${accent}" />
  `;
}

// ---------- copy ----------

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 900);
    }
  } catch {
    // best-effort fallback: select and prompt
    window.prompt('Copy path:', text);
  }
}

// ---------- session list ----------

async function loadSessions() {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.sessions = await r.json();
    renderSessions();
  } catch (e) {
    $('session-list').textContent = 'error: ' + e.message;
  }
}

function sessionMatchesSearch(s, q) {
  if (!q) return true;
  const hay = [s.title, s.cwd, s.model, s.id, s.subagent_info?.description, s.subagent_info?.type]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

// Build a parent->children tree from the flat list.
function buildSessionTree(list) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const childrenOf = new Map();
  const roots = [];
  for (const s of list) {
    if (s.parent_id && byId.has(s.parent_id)) {
      const arr = childrenOf.get(s.parent_id) || [];
      arr.push(s);
      childrenOf.set(s.parent_id, arr);
    } else {
      roots.push(s);
    }
  }
  // Sort children by their parent's spawn order (last_active desc keeps newer first).
  for (const [, children] of childrenOf) children.sort((a, b) => b.last_active - a.last_active);
  // If parent was filtered out by search, surface its child as a root so it doesn't vanish.
  return { roots, childrenOf };
}

function filteredSessions() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.sessions;
  // Keep a session if it matches OR any of its descendants match (parents stay anchored).
  const { childrenOf } = buildSessionTree(state.sessions);
  const keep = new Set();
  const markUp = (id) => {
    if (keep.has(id)) return;
    keep.add(id);
    const s = state.sessions.find((x) => x.id === id);
    if (s?.parent_id) markUp(s.parent_id);
  };
  for (const s of state.sessions) {
    if (sessionMatchesSearch(s, q)) markUp(s.id);
  }
  // Also keep all children of kept parents (so a parent match shows its full subtree).
  let added = true;
  while (added) {
    added = false;
    for (const [pid, kids] of childrenOf) {
      if (!keep.has(pid)) continue;
      for (const k of kids) if (!keep.has(k.id)) { keep.add(k.id); added = true; }
    }
  }
  return state.sessions.filter((s) => keep.has(s.id));
}

function renderSessions() {
  const root = $('session-list');
  const cnt = $('sidebar-count');
  root.innerHTML = '';
  const list = filteredSessions();
  cnt.textContent = list.length;
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = state.search ? 'no matches' : 'no sessions found';
    root.appendChild(d);
    return;
  }
  const { roots, childrenOf } = buildSessionTree(list);

  const renderNode = (s, depth) => {
    const kids = childrenOf.get(s.id) || [];
    const isCollapsed = state.collapsed.has(s.id);
    const isSubagent = !!s.parent_id;
    const info = s.subagent_info || null;

    const btn = document.createElement('button');
    btn.className = 'sess-item';
    if (s.id === state.activeId) btn.classList.add('active');
    if (isSubagent) btn.classList.add('subagent');
    if (s.is_worktree && !isSubagent) btn.classList.add('worktree');
    btn.style.setProperty('--depth', String(depth));
    btn.type = 'button';
    btn.onclick = (ev) => {
      // ignore clicks on the chevron
      if (ev.target.closest('.sess-chevron')) return;
      state.activeId = s.id;
      state.pinned = true;
      resetHistory();
      restartStream();
      renderSessions();
      // auto-switch to session view when a session is selected
      setView('session');
      loadFiles(s.id);
      loadGit(s.id);
    };

    const head = document.createElement('div');
    head.className = 'sess-head';

    if (kids.length) {
      const chev = document.createElement('span');
      chev.className = 'sess-chevron' + (isCollapsed ? ' collapsed' : '');
      chev.textContent = isCollapsed ? '▶' : '▼';
      chev.title = isCollapsed ? 'Expand subagents' : 'Collapse subagents';
      chev.onclick = (ev) => {
        ev.stopPropagation();
        if (state.collapsed.has(s.id)) state.collapsed.delete(s.id);
        else state.collapsed.add(s.id);
        renderSessions();
      };
      head.appendChild(chev);
    } else {
      const sp = document.createElement('span');
      sp.className = 'sess-chevron empty';
      head.appendChild(sp);
    }

    const titleWrap = document.createElement('div');
    titleWrap.className = 'sess-titles';

    const t = document.createElement('div');
    t.className = 'sess-title';
    if (isSubagent && info?.description) {
      t.textContent = info.description;
    } else {
      t.textContent = s.title || '(untitled)';
    }

    const sub = document.createElement('div');
    sub.className = 'sess-sub';
    if (isSubagent) {
      const status = info?.status || '?';
      const dur = info?.duration_ms ? ` · ${Math.round(info.duration_ms / 1000)}s` : '';
      const tools = info?.tool_calls ? ` · ${info.tool_calls} tools` : '';
      sub.innerHTML = `<span class="badge badge-${status}">${info?.type || 'subagent'}</span> <span class="badge-status">${status}</span>${dur}${tools}`;
    } else {
      sub.textContent = truncMid(s.cwd, 38);
      sub.title = s.cwd;
    }

    const m = document.createElement('div');
    m.className = 'sess-meta';
    if (isSubagent) {
      m.textContent = `${s.model || '?'} · ${s.num_messages || 0} msgs · ${fmtAgo(s.last_active)}`;
    } else {
      const kidCount = kids.length ? ` · ${kids.length} subagent${kids.length > 1 ? 's' : ''}` : '';
      m.textContent = `${s.model || '?'} · ${s.num_messages || 0} msgs · ${fmtAgo(s.last_active)}${kidCount}`;
    }

    titleWrap.append(t, sub, m);
    head.appendChild(titleWrap);
    btn.appendChild(head);
    root.appendChild(btn);

    if (!isCollapsed) {
      for (const k of kids) renderNode(k, depth + 1);
    }
  };

  for (const r of roots) renderNode(r, 0);
}

function resetHistory() {
  for (const k of Object.keys(state.history)) state.history[k] = [];
}

// ---------- view switching ----------

function setView(v) {
  state.view = v;
  for (const t of document.querySelectorAll('.view-tab')) {
    t.classList.toggle('active', t.dataset.view === v);
  }
  $('panel-overview').hidden = v !== 'overview';
  $('panel-session').hidden = v !== 'session';
  if (v === 'overview') loadOverview();
  if (v === 'session' && state.activeId) {
    loadFiles(state.activeId);
    loadGit(state.activeId);
  }
}

// ---------- overview ----------

function fmtBytesShort(n) {
  if (n == null) return '-';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + 'M';
  return (n / 1024 / 1024 / 1024).toFixed(2) + 'G';
}

async function loadOverview() {
  try {
    const r = await fetch('/api/overview');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.overview = await r.json();
    renderOverview();
  } catch (e) {
    $('overview-projects').textContent = 'error: ' + e.message;
  }
}

function renderOverview() {
  const ov = state.overview;
  if (!ov) return;
  const t = ov.totals;

  // metric strip with all-time totals (overrides session-mode values)
  $('m-tokens').textContent = fmtNum(t.tokens_input + t.tokens_output);
  $('m-token-rate').textContent = 'all time';
  $('m-loc').textContent = fmtNum(t.lines_added);
  $('m-loc-delta').textContent = `${ov.totals.files_touched} files`;
  $('m-tools').textContent = fmtNum(t.tools_started);
  $('m-tool-delta').textContent = `${t.turns_started} turns`;
  $('m-cost').textContent = '$' + (t.cost_usd || 0).toFixed(4);
  $('m-cost-calls').textContent = `${t.api_calls} calls`;
  $('m-turns').textContent = fmtNum(t.sessions);
  $('m-turn-errors').textContent = `${t.main_sessions} main + ${t.subagents} sub`;

  // Static sparklines from activity data
  renderSpark('spark-tokens', ov.activity.map((d) => d.sessions), '#5eead4');
  renderSpark('spark-loc', ov.activity.map((d) => d.lines), '#86efac');
  renderSpark('spark-tools', ov.activity.map((d) => d.sessions), '#c4b5fd');
  renderSpark('spark-cost', ov.activity.map((d) => d.cost), '#fbbf24');
  renderSpark('spark-turns', ov.activity.map((d) => d.sessions), '#f9a8d4');

  // Top projects
  const projRoot = $('overview-projects');
  projRoot.innerHTML = '';
  if (!ov.top_projects.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no projects';
    projRoot.appendChild(d);
  } else {
    for (const p of ov.top_projects) {
      const row = document.createElement('div');
      row.className = 'proj-row';
      const short = p.cwd.replace(/^\/Users\/[^/]+\//, '~/');
      row.innerHTML = `
        <span class="proj-name" title="${p.cwd}">${short}</span>
        <span class="proj-sessions">${p.sessions} sess</span>
        <span class="proj-lines added">+${fmtNum(p.lines_added)}</span>
        <span class="proj-when">${fmtAgo(p.last_active)}</span>
      `;
      projRoot.appendChild(row);
    }
  }

  // Activity strip - calendar-like
  const actRoot = $('overview-activity');
  actRoot.innerHTML = '';
  const maxLines = Math.max(...ov.activity.map((d) => d.lines), 1);
  for (const day of ov.activity) {
    const cell = document.createElement('div');
    cell.className = 'act-cell';
    const intensity = Math.min(4, Math.floor((day.lines / maxLines) * 5));
    cell.dataset.level = String(day.lines === 0 ? 0 : Math.max(1, intensity));
    cell.title = `${day.day}: ${day.sessions} sessions, ${day.lines} lines added`;
    actRoot.appendChild(cell);
  }

  // Top extensions + tools as bars
  renderBars($('overview-ext'), ov.top_extensions.map((e) => ({ name: '.' + e.ext, value: e.lines })));
  renderBars($('overview-tools'), ov.top_tools.map((t) => ({ name: t.name, value: t.count })));
}

// ---------- files + git ----------

async function loadFiles(sid) {
  try {
    const r = await fetch(`/api/session/${sid}/files`);
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
      <span class="muted">${fmtBytesShort(f.size)}</span>
      <span class="when">${fmtAgo(f.mtime / 1000)}</span>
    `;
    root.appendChild(row);
  }
  pagerEl.append(...buildPager(state.pages.files, pages, (p) => {
    state.pages.files = p;
    renderFiles();
  }, list.length));
}

async function loadGit(sid) {
  try {
    const r = await fetch(`/api/session/${sid}/git`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.git = { cwd: state.lastStats?.meta?.cwd || null, info: await r.json() };
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

function buildPager(page, pages, onChange, total) {
  if (pages <= 1) {
    const span = document.createElement('span');
    span.className = 'pager-info';
    span.textContent = `${total} total`;
    return [span];
  }
  const prev = document.createElement('button');
  prev.className = 'pager-btn';
  prev.type = 'button';
  prev.textContent = '←';
  prev.disabled = page <= 0;
  prev.onclick = () => onChange(Math.max(0, page - 1));

  const next = document.createElement('button');
  next.className = 'pager-btn';
  next.type = 'button';
  next.textContent = '→';
  next.disabled = page >= pages - 1;
  next.onclick = () => onChange(Math.min(pages - 1, page + 1));

  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = `${page + 1}/${pages} · ${total}`;

  return [prev, info, next];
}

// ---------- stats render ----------

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

  // header
  $('session-title').textContent = m.title || '(untitled)';
  $('session-model').textContent = m.model || '?';
  const cwd = m.cwd || '';
  const cwdEl = $('session-cwd');
  cwdEl.textContent = cwd;
  cwdEl.title = cwd;
  $('copy-cwd').dataset.copy = cwd;
  $('foot-session').textContent = m.id || '-';
  $('foot-last-event').textContent = fmtAgo(fl.last_event_ts);

  // metrics strip - push to history then render
  const tokensTotal = tk.last_total_tokens || 0;
  const locTotal = lc.lines_added || 0;
  const toolsTotal = fl.tools_started || 0;
  const costTotal = us.cost_usd || 0;
  const turnsTotal = fl.turns_started || 0;

  // delta vs last sample for the rate readouts on the metric strip
  const prev = {
    tokens: state.history.tokens.at(-1) || 0,
    loc: state.history.loc.at(-1) || 0,
    tools: state.history.tools.at(-1) || 0,
    cost: state.history.cost.at(-1) || 0,
    turns: state.history.turns.at(-1) || 0,
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
  $('m-cost').textContent = '$' + (costTotal).toFixed(4);
  $('m-cost-calls').textContent = `${fmtNum(us.calls || 0)} calls`;
  $('m-turns').textContent = fmtNum(turnsTotal);
  $('m-turn-errors').textContent = `${fmtNum(fl.turns_error || 0)} err`;

  renderSpark('spark-tokens', state.history.tokens, '#5eead4');
  renderSpark('spark-loc', state.history.loc, '#86efac');
  renderSpark('spark-tools', state.history.tools, '#c4b5fd');
  renderSpark('spark-cost', state.history.cost, '#fbbf24');
  renderSpark('spark-turns', state.history.turns, '#f9a8d4');

  // big cards
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
  $('card-usage-cost').textContent = '$' + (us.cost_usd || 0).toFixed(4);

  renderUsageChart(us.per_call || []);
  renderBars($('tool-bars'), tools.slice(0, 12).map((t) => ({ name: t.name, value: t.count })));
  renderBars(
    $('ext-bars'),
    (lc.by_ext || []).map((e) => ({ name: '.' + e.ext, value: e.lines })),
  );

  renderRecentEdits(lc.recent_edits || []);

  // sidebar selection highlight
  for (const el of document.querySelectorAll('.sess-item')) el.classList.remove('active');
  const items = document.querySelectorAll('.sess-item');
  const list = filteredSessions();
  const idx = list.findIndex((s) => s.id === state.activeId);
  if (idx >= 0 && items[idx]) items[idx].classList.add('active');
}

function renderBars(root, items) {
  root.innerHTML = '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no data yet';
    root.appendChild(d);
    return;
  }
  const max = Math.max(...items.map((i) => i.value || 0), 1);
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const pct = Math.max(1, Math.round(((it.value || 0) / max) * 100));
    row.innerHTML = `
      <span class="bar-name" title="${it.name}">${it.name}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="bar-val">${fmtNum(it.value || 0)}</span>
    `;
    root.appendChild(row);
  }
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
      <div class="chart-stack" title="in ${fmtNum(c.input)} (cached ${fmtNum(c.cached)}) · out ${fmtNum(c.output)} (reasoning ${fmtNum(c.reasoning)}) · cost $${(c.cost_usd || 0).toFixed(4)}">
        <div class="seg seg-in" style="width:${inPctOfMax}%">
          <div class="seg-cached" style="width:${cachedPct}%"></div>
        </div>
        <div class="seg seg-out" style="width:${outPctOfMax}%">
          <div class="seg-reason" style="width:${reasonPct}%"></div>
        </div>
      </div>
      <span class="chart-val"><span class="usage-in">${fmtNum(c.input)}</span> / <span class="usage-out">${fmtNum(c.output)}</span></span>
      <span class="chart-cost">$${(c.cost_usd || 0).toFixed(3)}</span>
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

// ---------- SSE ----------

function setLive(on, text) {
  const dot = $('live-dot');
  const txt = $('live-text');
  if (on) dot.classList.add('on');
  else dot.classList.remove('on');
  if (text) txt.textContent = text;
}

function restartStream() {
  if (state.evtSource) {
    state.evtSource.close();
    state.evtSource = null;
  }
  const url = state.pinned && state.activeId
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
    } catch (e) {
      // swallow
    }
  };
}

// ---------- wiring ----------

function wireUi() {
  // search
  const input = $('session-search');
  const clear = $('session-search-clear');
  const apply = () => {
    state.search = input.value;
    clear.hidden = !input.value;
    renderSessions();
  };
  input.addEventListener('input', apply);
  clear.addEventListener('click', () => {
    input.value = '';
    apply();
    input.focus();
  });
  // global keyboard shortcut: / focuses search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
  });

  // copy cwd
  $('copy-cwd').addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    const path = btn.dataset.copy || '';
    if (path) copyText(path, btn);
  });

  // view tabs
  for (const t of document.querySelectorAll('.view-tab')) {
    t.addEventListener('click', () => setView(t.dataset.view));
  }
}

async function init() {
  wireUi();
  await Promise.all([loadSessions(), loadCaptures(), loadOverview()]);
  setView('overview');
  restartStream();
  setInterval(loadSessions, 5000);
  setInterval(loadCaptures, 5000);
  setInterval(() => {
    if (state.view === 'overview') loadOverview();
  }, 15000);
  setInterval(() => {
    if (state.activeId && state.view === 'session') {
      loadFiles(state.activeId);
      loadGit(state.activeId);
    }
  }, 10000);
  setInterval(() => {
    if (state.lastEventAt && Date.now() - state.lastEventAt > 4000) {
      setLive(false, 'stale');
    }
  }, 1000);
}

init();
