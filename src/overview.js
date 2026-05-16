// Main dashboard - all-time aggregates with multiple charts.

import {
  $, fmtNum, fmtAgo, truncMid, renderBars, renderSpark, renderLineChart, renderDonut, setLive,
  loadSidebarSessions, wireSidebar,
} from './common.js';

const VALID_RANGES = ['1m', '5m', '30m', '24h', '7d', '30d', '90d', 'all'];
const LS_RANGE_KEY = 'grokscope.overview.range';
const LS_LIVE_KEY = 'grokscope.overview.live';

const LIVE_INTERVAL_MS = 3000;   // poll cadence when live mode is on
const IDLE_INTERVAL_MS = 60000;  // poll cadence when live mode is off

function loadSavedRange() {
  try {
    const v = localStorage.getItem(LS_RANGE_KEY);
    if (v && VALID_RANGES.includes(v)) return v;
  } catch {}
  return '30d';
}

function loadSavedLive() {
  try {
    const v = localStorage.getItem(LS_LIVE_KEY);
    if (v === '0' || v === 'false') return false;
  } catch {}
  return true; // default to on
}

const state = {
  overview: null,
  range: loadSavedRange(),
  live: loadSavedLive(),
  pollTimer: null,
};

const RANGE_TITLES = {
  '1m':  'Activity (last 1 minute)',
  '5m':  'Activity (last 5 minutes)',
  '30m': 'Activity (last 30 minutes)',
  '24h': 'Activity (last 24 hours)',
  '7d':  'Activity (last 7 days)',
  '30d': 'Activity (last 30 days)',
  '90d': 'Activity (last 90 days)',
  'all': 'Activity (all time)',
};

async function loadOverview() {
  try {
    const params = new URLSearchParams({ range: state.range });
    if (state.live) params.set('fresh', '1');
    const r = await fetch('/api/overview?' + params.toString());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.overview = await r.json();
    const status = state.live
      ? `${state.overview.totals.sessions} sessions · live`
      : `${state.overview.totals.sessions} sessions · paused`;
    setLive(true, status);
    renderOverview();
  } catch (e) {
    setLive(false, 'error');
    const root = $('overview-projects');
    if (root) root.textContent = 'error: ' + e.message;
  }
}

function applyLiveUI() {
  const btn = $('live-toggle');
  if (btn) {
    btn.classList.toggle('on', state.live);
    btn.title = state.live ? 'Live updates on (click to pause)' : 'Paused (click to resume)';
  }
  const rate = $('live-toggle-rate');
  if (rate) rate.textContent = state.live ? `${LIVE_INTERVAL_MS / 1000}s` : 'off';
}

function setLiveMode(on) {
  if (state.live === on) return;
  state.live = on;
  try { localStorage.setItem(LS_LIVE_KEY, on ? '1' : '0'); } catch {}
  applyLiveUI();
  restartPolling();
  if (on) loadOverview(); // fire one immediately when re-enabling
}

function restartPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const interval = state.live ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
  state.pollTimer = setInterval(loadOverview, interval);
}

function applyRangePillUI(key) {
  for (const b of document.querySelectorAll('.range-pill')) {
    b.classList.toggle('active', b.dataset.range === key);
  }
  const title = RANGE_TITLES[key] || `Activity (${key})`;
  const tEl = $('activity-title');
  if (tEl) tEl.textContent = title;
}

function setRange(key) {
  if (state.range === key) return;
  state.range = key;
  try { localStorage.setItem(LS_RANGE_KEY, key); } catch {}
  applyRangePillUI(key);
  loadOverview();
}

function renderOverview() {
  const ov = state.overview;
  if (!ov) return;
  const t = ov.totals;
  const a = ov.averages || {};
  const act = ov.activity || [];

  // Primary metrics strip
  $('m-tokens').textContent = fmtNum(t.tokens_input + t.tokens_output);
  $('m-token-rate').textContent = 'all time';
  $('m-loc').textContent = fmtNum(t.lines_added);
  $('m-loc-delta').textContent = `${fmtNum(t.files_touched)} files`;
  $('m-tools').textContent = fmtNum(t.tools_started);
  $('m-tool-delta').textContent = `${fmtNum(t.turns_started)} turns`;
  $('m-turns').textContent = fmtNum(t.sessions);
  $('m-turn-errors').textContent = `${t.main_sessions} main · ${t.subagents} sub`;

  renderSpark($('spark-tokens'), act.map((d) => d.sessions), '#5eead4');
  renderSpark($('spark-loc'), act.map((d) => d.lines), '#86efac');
  renderSpark($('spark-tools'), act.map((d) => d.sessions), '#c4b5fd');
  renderSpark($('spark-turns'), act.map((d) => d.sessions), '#f9a8d4');

  // Secondary KPIs
  $('k-messages').textContent = fmtNum(t.messages);
  $('k-turns').textContent = fmtNum(t.turns_started);
  $('k-turn-err').textContent = `${t.turns_error} errored`;
  $('k-files').textContent = fmtNum(t.files_touched);
  $('k-perms').textContent = fmtNum(t.permission_prompts);
  $('k-avg-loc').textContent = fmtNum(a.lines_per_session || 0);
  $('k-avg-tools').textContent = fmtNum(a.tools_per_session || 0);
  $('k-avg-sub').textContent = (a.subagents_per_session || 0).toFixed(2);

  // Activity heatmap
  renderActivityGrid(act);
  $('activity-summary').textContent = `${act.reduce((s, d) => s + d.sessions, 0)} sessions · ${fmtNum(act.reduce((s, d) => s + d.lines, 0))} lines`;

  // Chart titles follow the bucket granularity
  const bucketMs = ov.range?.bucket_ms || 86400000;
  let unit = 'day';
  if (bucketMs <= 60 * 1000) unit = 'minute';
  else if (bucketMs <= 60 * 60 * 1000) unit = 'hour';
  $('chart-sessions-title').textContent = `Sessions per ${unit}`;
  $('chart-lines-title').textContent = `Lines written per ${unit}`;
  // Cumulative chart titles get a range qualifier so it's clear what window they sum over.
  const rangeLabel = ov.range?.label || '';
  $('chart-cum-lines-title').textContent = rangeLabel
    ? `Cumulative lines (${rangeLabel})`
    : 'Cumulative lines';

  // Line charts
  renderLineChart($('chart-sessions'), act.map((d) => ({ x: d.day, y: d.sessions })), { accent: '#79c0ff', area: true });
  renderLineChart($('chart-lines'), act.map((d) => ({ x: d.day, y: d.lines })), { accent: '#86efac', area: true });
  renderLineChart($('chart-cum-lines'), act.map((d) => ({ x: d.day, y: d.cum_lines })), { accent: '#5eead4', area: true });

  // Top projects with mini progress bars
  const projRoot = $('overview-projects');
  projRoot.innerHTML = '';
  if (!ov.top_projects.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no projects';
    projRoot.appendChild(d);
  } else {
    const maxLines = Math.max(...ov.top_projects.map((p) => p.lines_added), 1);
    for (const p of ov.top_projects) {
      const row = document.createElement('div');
      row.className = 'proj-row';
      const short = p.cwd.replace(/^\/Users\/[^/]+\//, '~/');
      const pct = Math.max(1, Math.round((p.lines_added / maxLines) * 100));
      row.innerHTML = `
        <span class="proj-name" title="${p.cwd}">${short}</span>
        <span class="proj-sessions">${p.sessions}s</span>
        <div class="proj-bar"><div class="proj-bar-fill" style="width:${pct}%"></div></div>
        <span class="proj-lines added">+${fmtNum(p.lines_added)}</span>
        <span class="proj-when">${fmtAgo(p.last_active)}</span>
      `;
      projRoot.appendChild(row);
    }
  }

  // Top sessions
  const tsRoot = $('overview-top-sessions');
  tsRoot.innerHTML = '';
  if (!ov.top_sessions.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no sessions yet';
    tsRoot.appendChild(d);
  } else {
    for (const s of ov.top_sessions) {
      const row = document.createElement('a');
      row.className = 'sess-table-row';
      row.href = `/session.html?id=${encodeURIComponent(s.id)}`;
      row.innerHTML = `
        <span class="proj-name" title="${s.title}">${s.title || '(untitled)'}</span>
        <span class="muted">${s.model || '?'}</span>
        <span class="proj-lines added">+${fmtNum(s.lines_added)}</span>
        <span class="proj-when">${fmtAgo(s.last_active)}</span>
      `;
      tsRoot.appendChild(row);
    }
  }

  // Tools bar + extension donut
  renderBars($('overview-tools'), ov.top_tools.map((t) => ({ name: t.name, value: t.count })));
  renderDonut($('overview-ext-donut'), ov.top_extensions.slice(0, 6).map((e) => ({ name: '.' + e.ext, value: e.lines })));

  // Recent sessions table
  const rcRoot = $('overview-recent');
  rcRoot.innerHTML = '';
  if (!ov.recent_sessions.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no recent activity';
    rcRoot.appendChild(d);
  } else {
    const header = document.createElement('div');
    header.className = 'sess-table-row sess-table-header';
    header.innerHTML = `
      <span>Title</span>
      <span>cwd</span>
      <span>Model</span>
      <span>Subagents</span>
      <span>Lines</span>
      <span>Last active</span>
    `;
    rcRoot.appendChild(header);
    for (const s of ov.recent_sessions) {
      const row = document.createElement('a');
      row.className = 'sess-table-row';
      row.href = `/session.html?id=${encodeURIComponent(s.id)}`;
      const cwd = s.cwd.replace(/^\/Users\/[^/]+\//, '~/');
      row.innerHTML = `
        <span class="proj-name" title="${s.title}">${s.title || '(untitled)'}</span>
        <span class="proj-cwd" title="${s.cwd}">${truncMid(cwd, 32)}</span>
        <span class="muted">${s.model || '?'}</span>
        <span class="muted">${s.subagent_count}</span>
        <span class="proj-lines added">+${fmtNum(s.lines_added)}</span>
        <span class="proj-when">${fmtAgo(s.last_active)}</span>
      `;
      rcRoot.appendChild(row);
    }
  }
}

function renderActivityGrid(act) {
  const root = $('overview-activity');
  root.innerHTML = '';
  if (!act.length) return;
  const maxLines = Math.max(...act.map((d) => d.lines), 1);
  for (const day of act) {
    const cell = document.createElement('div');
    cell.className = 'act-cell';
    const intensity = Math.min(4, Math.floor((day.lines / maxLines) * 5));
    cell.dataset.level = String(day.lines === 0 ? 0 : Math.max(1, intensity));
    cell.title = `${day.day}: ${day.sessions} sessions, ${day.lines} lines`;
    root.appendChild(cell);
  }
}

async function init() {
  wireSidebar();
  applyRangePillUI(state.range);
  applyLiveUI();
  for (const b of document.querySelectorAll('.range-pill')) {
    b.addEventListener('click', () => setRange(b.dataset.range));
  }
  const liveBtn = $('live-toggle');
  if (liveBtn) liveBtn.addEventListener('click', () => setLiveMode(!state.live));

  // Pause polling while the tab is hidden to save cycles
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = null;
    } else {
      loadOverview();
      restartPolling();
    }
  });

  await Promise.all([loadSidebarSessions(), loadOverview()]);
  setInterval(loadSidebarSessions, 5000);
  restartPolling();
}

init();
