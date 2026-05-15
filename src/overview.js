// Main dashboard - all-time aggregates across every Grok session.

import {
  $, fmtNum, fmtAgo, renderBars, renderSpark, setLive,
  loadSidebarSessions, renderSidebarSessions, wireSidebar,
} from './common.js';

const state = {
  overview: null,
};

async function loadOverview() {
  try {
    const r = await fetch('/api/overview');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.overview = await r.json();
    setLive(true, `${state.overview.totals.sessions} sessions tracked`);
    renderOverview();
  } catch (e) {
    setLive(false, 'error');
    $('overview-projects').textContent = 'error: ' + e.message;
  }
}

function renderOverview() {
  const ov = state.overview;
  if (!ov) return;
  const t = ov.totals;

  $('m-tokens').textContent = fmtNum(t.tokens_input + t.tokens_output);
  $('m-token-rate').textContent = 'all time';
  $('m-loc').textContent = fmtNum(t.lines_added);
  $('m-loc-delta').textContent = `${fmtNum(t.files_touched)} files`;
  $('m-tools').textContent = fmtNum(t.tools_started);
  $('m-tool-delta').textContent = `${fmtNum(t.turns_started)} turns`;
  $('m-cost').textContent = '$' + (t.cost_usd || 0).toFixed(4);
  $('m-cost-calls').textContent = `${fmtNum(t.api_calls)} calls`;
  $('m-turns').textContent = fmtNum(t.sessions);
  $('m-turn-errors').textContent = `${t.main_sessions} main · ${t.subagents} sub`;

  renderSpark($('spark-tokens'), ov.activity.map((d) => d.sessions), '#5eead4');
  renderSpark($('spark-loc'), ov.activity.map((d) => d.lines), '#86efac');
  renderSpark($('spark-tools'), ov.activity.map((d) => d.sessions), '#c4b5fd');
  renderSpark($('spark-cost'), ov.activity.map((d) => d.cost), '#fbbf24');
  renderSpark($('spark-turns'), ov.activity.map((d) => d.sessions), '#f9a8d4');

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

  renderBars($('overview-ext'), ov.top_extensions.map((e) => ({ name: '.' + e.ext, value: e.lines })));
  renderBars($('overview-tools'), ov.top_tools.map((t) => ({ name: t.name, value: t.count })));
}

async function init() {
  wireSidebar();
  await Promise.all([loadSidebarSessions(), loadOverview()]);
  setInterval(loadSidebarSessions, 5000);
  setInterval(loadOverview, 15000);
}

init();
