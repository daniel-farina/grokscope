// Grok dashboard frontend - vanilla JS.

const $ = (id) => document.getElementById(id);

const state = {
  sessions: [],
  activeId: null,
  pinned: false,
  evtSource: null,
  lastEventAt: 0,
};

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '0';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'k';
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

function renderSessions() {
  const root = $('session-list');
  root.innerHTML = '';
  if (!state.sessions.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no sessions found';
    root.appendChild(d);
    return;
  }
  for (const s of state.sessions) {
    const btn = document.createElement('button');
    btn.className = 'sess-item' + (s.id === state.activeId ? ' active' : '') + (s.is_worktree ? ' worktree' : '');
    btn.type = 'button';
    btn.onclick = () => {
      state.activeId = s.id;
      state.pinned = true;
      restartStream();
      renderSessions();
    };

    const t = document.createElement('div');
    t.className = 'sess-title';
    t.textContent = s.title || '(untitled)';

    const c = document.createElement('div');
    c.className = 'sess-cwd';
    c.textContent = truncMid(s.cwd, 38);

    const m = document.createElement('div');
    m.className = 'sess-meta';
    m.textContent = `${s.model || '?'} · ${s.num_messages || 0} msgs · ${fmtAgo(s.last_active)}`;

    const id = document.createElement('div');
    id.className = 'sess-id';
    id.textContent = s.id.slice(0, 18);

    btn.append(t, c, m, id);
    root.appendChild(btn);
  }
}

// ---------- captures ----------

async function loadCaptures() {
  try {
    const r = await fetch('/api/captures');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    renderCaptures(rows);
  } catch (e) {
    $('captures').textContent = 'error: ' + e.message;
  }
}

function renderCaptures(rows) {
  const root = $('captures');
  root.innerHTML = '';
  if (!rows.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no captures (start grok-tap to record HTTP traffic)';
    root.appendChild(d);
    return;
  }
  for (const r of rows.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'capt-row';
    const status = Number(r.status || 0);
    const statusClass = status >= 200 && status < 400 ? 'status-ok' : 'status-bad';
    row.innerHTML = `
      <span>${r.ts || ''}</span>
      <span>${r.method || ''}</span>
      <span class="path" title="${r.path || ''}">${r.path || ''}</span>
      <span class="${statusClass}">${r.status ?? '-'}</span>
      <span class="muted">${r.elapsed_ms ?? '-'}ms</span>
      <span class="muted">${fmtBytes(r.resp_bytes)}</span>
    `;
    root.appendChild(row);
  }
}

// ---------- stats render ----------

function renderStats(stats) {
  if (!stats) return;
  const m = stats.meta || {};
  const tk = stats.tokens || {};
  const lc = stats.loc || {};
  const fl = stats.flow || {};
  const tools = stats.tools || [];

  state.activeId = m.id;
  state.lastEventAt = Date.now();

  // header
  $('session-title').textContent = m.title || '(untitled)';
  $('session-model').textContent = m.model || '?';
  $('session-cwd').textContent = m.cwd || '';
  $('session-cwd').title = m.cwd || '';
  $('foot-session').textContent = m.id || '-';
  $('foot-last-event').textContent = fmtAgo(fl.last_event_ts);

  // cards
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

  const us = stats.usage || { calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: 0, per_call: [] };
  $('card-usage-in').textContent = fmtNum(us.input_tokens);
  $('card-usage-out').textContent = fmtNum(us.output_tokens);
  $('card-usage-calls').textContent = fmtNum(us.calls);
  $('card-usage-cached').textContent = fmtNum(us.cached_tokens);
  $('card-usage-cost').textContent = '$' + (us.cost_usd || 0).toFixed(4);
  renderUsageChart(us.per_call || []);

  renderBars($('tool-bars'), tools.slice(0, 12).map((t) => ({ name: t.name, value: t.count })));
  renderBars(
    $('ext-bars'),
    (lc.by_ext || []).map((e) => ({ name: '.' + e.ext, value: e.lines })),
  );

  renderRecentEdits(lc.recent_edits || []);

  // update sidebar selection highlight without refetching
  if (state.sessions.length) {
    for (const el of document.querySelectorAll('.sess-item')) el.classList.remove('active');
    const matchIndex = state.sessions.findIndex((s) => s.id === state.activeId);
    if (matchIndex >= 0) {
      const items = document.querySelectorAll('.sess-item');
      if (items[matchIndex]) items[matchIndex].classList.add('active');
    }
  }
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
  if (!root) return;
  root.innerHTML = '';
  if (!calls.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no captured API calls for this session. To capture: re-enable grok-tap by adding base_url = "http://127.0.0.1:18080/v1" to [model.grok-build] in ~/.grok/config.toml';
    root.appendChild(d);
    return;
  }
  const maxTotal = Math.max(...calls.map((c) => c.input + c.output), 1);
  const totalIn = calls.reduce((s, c) => s + c.input, 0);
  const totalOut = calls.reduce((s, c) => s + c.output, 0);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = `
    <span class="leg in"><i></i> input (${fmtNum(totalIn)})</span>
    <span class="leg out"><i></i> output (${fmtNum(totalOut)})</span>
    <span class="leg reason"><i></i> of which reasoning</span>
    <span class="leg cached"><i></i> of which cached input</span>
  `;
  root.appendChild(legend);

  // Bars
  const list = document.createElement('div');
  list.className = 'chart-bars';
  calls.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'chart-row';
    const total = c.input + c.output;
    const inPctOfMax = Math.round((c.input / maxTotal) * 100);
    const outPctOfMax = Math.round((c.output / maxTotal) * 100);
    const reasonPct = c.output ? Math.round((c.reasoning / c.output) * 100) : 0;
    const cachedPct = c.input ? Math.round((c.cached / c.input) * 100) : 0;
    row.innerHTML = `
      <span class="chart-idx">#${i + 1}</span>
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
}

function renderRecentEdits(edits) {
  const root = $('recent-edits');
  root.innerHTML = '';
  if (!edits.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no edits yet';
    root.appendChild(d);
    return;
  }
  for (const e of edits) {
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

// ---------- bootstrap ----------

async function init() {
  await Promise.all([loadSessions(), loadCaptures()]);
  restartStream();
  setInterval(loadSessions, 5000);
  setInterval(loadCaptures, 5000);
  setInterval(() => {
    // gentle staleness check
    if (state.lastEventAt && Date.now() - state.lastEventAt > 4000) {
      setLive(false, 'stale');
    }
  }, 1000);
}

init();
