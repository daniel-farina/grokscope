// Shared helpers + sidebar across pages.

export const $ = (id) => document.getElementById(id);
export const PAGE_SIZE = 10;

export function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '0';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1) + 'k';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'k';
  return Math.round(n).toLocaleString();
}

export function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + 'M';
  return (n / 1024 / 1024 / 1024).toFixed(2) + 'G';
}

export function fmtAgo(epochS) {
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

export function truncMid(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  const keep = max - 3;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + '...' + s.slice(-tail);
}

export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 900);
    }
  } catch {
    window.prompt('Copy:', text);
  }
}

export function buildPager(page, pages, onChange, total) {
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

export function renderBars(root, items) {
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

// Line chart with optional axis labels.
// data: array of {x: Date|string, y: number}
// opts: { accent, area: bool, labels: bool, height: number }
export function renderLineChart(svg, data, opts = {}) {
  if (!svg) return;
  const accent = opts.accent || '#5eead4';
  const area = opts.area !== false;
  const labels = opts.labels !== false;
  svg.innerHTML = '';
  if (!data.length) return;
  const w = 600, h = opts.height || 180;
  const padL = labels ? 36 : 6, padR = 8, padT = 10, padB = labels ? 20 : 6;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const ys = data.map((d) => d.y);
  const minY = 0;
  const maxY = Math.max(...ys, 1);
  const stepX = data.length > 1 ? plotW / (data.length - 1) : plotW;
  const points = data.map((d, i) => {
    const x = padL + i * stepX;
    const y = padT + plotH - ((d.y - minY) / (maxY - minY)) * plotH;
    return [x, y];
  });

  let line = `M ${points[0][0]} ${points[0][1]} `;
  for (let i = 1; i < points.length; i++) line += `L ${points[i][0]} ${points[i][1]} `;

  let areaPath = '';
  if (area) {
    areaPath = `M ${points[0][0]} ${padT + plotH} `;
    for (const [x, y] of points) areaPath += `L ${x} ${y} `;
    areaPath += `L ${points[points.length - 1][0]} ${padT + plotH} Z`;
  }

  const gradId = (svg.id || 'g') + '-grad';
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  // y-axis ticks (4)
  let yTicks = '';
  if (labels) {
    for (let i = 0; i <= 3; i++) {
      const v = (maxY / 3) * (3 - i);
      const yy = padT + (plotH / 3) * i;
      yTicks += `<line x1="${padL}" y1="${yy}" x2="${w - padR}" y2="${yy}" stroke="rgba(255,255,255,0.04)" />`;
      yTicks += `<text x="${padL - 4}" y="${yy + 3}" fill="#6b7785" font-size="9" font-family="ui-monospace,monospace" text-anchor="end">${formatTick(v)}</text>`;
    }
  }
  // x-axis labels: first, middle, last
  let xTicks = '';
  if (labels && data.length > 1) {
    const pick = [0, Math.floor(data.length / 2), data.length - 1];
    for (const i of pick) {
      const x = padL + i * stepX;
      const lbl = String(data[i].x || '').slice(-5);
      xTicks += `<text x="${x}" y="${h - 4}" fill="#6b7785" font-size="9" font-family="ui-monospace,monospace" text-anchor="middle">${lbl}</text>`;
    }
  }

  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.30" />
        <stop offset="100%" stop-color="${accent}" stop-opacity="0" />
      </linearGradient>
    </defs>
    ${yTicks}
    ${area ? `<path d="${areaPath}" fill="url(#${gradId})" />` : ''}
    <path d="${line}" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="${points[points.length - 1][0]}" cy="${points[points.length - 1][1]}" r="2.5" fill="${accent}" />
    ${xTicks}
  `;
}

function formatTick(v) {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'k';
  if (v < 1 && v > 0) return v.toFixed(3);
  return Math.round(v).toString();
}

// Stacked area chart: data is array of {x, series: {a: n, b: n, ...}}, series order from `order`.
export function renderStackedChart(svg, data, order, colors, opts = {}) {
  if (!svg || !data.length) return;
  const w = 600, h = opts.height || 180;
  const padL = 36, padR = 8, padT = 10, padB = 20;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const totals = data.map((d) => order.reduce((s, k) => s + (d.series[k] || 0), 0));
  const maxY = Math.max(...totals, 1);
  const stepX = data.length > 1 ? plotW / (data.length - 1) : plotW;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  let html = '';
  // gridlines
  for (let i = 0; i <= 3; i++) {
    const yy = padT + (plotH / 3) * i;
    html += `<line x1="${padL}" y1="${yy}" x2="${w - padR}" y2="${yy}" stroke="rgba(255,255,255,0.04)" />`;
    const v = (maxY / 3) * (3 - i);
    html += `<text x="${padL - 4}" y="${yy + 3}" fill="#6b7785" font-size="9" font-family="ui-monospace,monospace" text-anchor="end">${formatTick(v)}</text>`;
  }
  // stack from bottom
  let prevYs = data.map(() => padT + plotH);
  for (const key of order) {
    const color = colors[key] || '#5eead4';
    const ys = data.map((d, i) => {
      const v = (d.series[key] || 0);
      const dy = (v / maxY) * plotH;
      return prevYs[i] - dy;
    });
    let area = `M ${padL} ${prevYs[0]} `;
    for (let i = 0; i < ys.length; i++) area += `L ${padL + i * stepX} ${ys[i]} `;
    for (let i = ys.length - 1; i >= 0; i--) area += `L ${padL + i * stepX} ${prevYs[i]} `;
    area += 'Z';
    html += `<path d="${area}" fill="${color}" opacity="0.85" />`;
    prevYs = ys;
  }
  svg.innerHTML = html;
}

// Donut chart for categorical breakdowns.
// items: [{name, value}], colors: array
export function renderDonut(root, items, colors) {
  root.innerHTML = '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'no data';
    root.appendChild(d);
    return;
  }
  const total = items.reduce((s, i) => s + (i.value || 0), 0) || 1;
  const radius = 56, ring = 16, cx = 70, cy = 70;
  const palette = colors || ['#5eead4', '#79c0ff', '#c4b5fd', '#fbbf24', '#f9a8d4', '#86efac', '#f97316', '#a78bfa'];
  let angleStart = -Math.PI / 2;
  let svgInner = '';
  items.forEach((it, idx) => {
    const frac = (it.value || 0) / total;
    if (frac <= 0) return;
    const angleEnd = angleStart + frac * Math.PI * 2;
    const x1 = cx + Math.cos(angleStart) * radius;
    const y1 = cy + Math.sin(angleStart) * radius;
    const x2 = cx + Math.cos(angleEnd) * radius;
    const y2 = cy + Math.sin(angleEnd) * radius;
    const ix1 = cx + Math.cos(angleStart) * (radius - ring);
    const iy1 = cy + Math.sin(angleStart) * (radius - ring);
    const ix2 = cx + Math.cos(angleEnd) * (radius - ring);
    const iy2 = cy + Math.sin(angleEnd) * (radius - ring);
    const large = frac > 0.5 ? 1 : 0;
    const color = palette[idx % palette.length];
    svgInner += `
      <path d="M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}
               L ${ix2} ${iy2} A ${radius - ring} ${radius - ring} 0 ${large} 0 ${ix1} ${iy1} Z"
            fill="${color}" />
    `;
    angleStart = angleEnd;
  });
  const wrap = document.createElement('div');
  wrap.className = 'donut-wrap';
  wrap.innerHTML = `
    <svg class="donut" viewBox="0 0 140 140">${svgInner}<text x="70" y="68" text-anchor="middle" fill="#e4e8ef" font-family="ui-monospace,monospace" font-size="13" font-weight="600">${total.toLocaleString()}</text><text x="70" y="84" text-anchor="middle" fill="#6b7785" font-family="ui-monospace,monospace" font-size="9">total</text></svg>
    <div class="donut-legend"></div>
  `;
  const legend = wrap.querySelector('.donut-legend');
  items.forEach((it, idx) => {
    const color = palette[idx % palette.length];
    const pct = (((it.value || 0) / total) * 100).toFixed(1);
    const row = document.createElement('div');
    row.className = 'donut-leg-row';
    row.innerHTML = `<i style="background:${color}"></i><span class="ll-name">${it.name}</span><span class="ll-val">${fmtNum(it.value)}</span><span class="ll-pct">${pct}%</span>`;
    legend.appendChild(row);
  });
  root.appendChild(wrap);
}

export function renderSpark(svg, data, accent) {
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
  let area = `M ${points[0][0]} ${h} `;
  for (const [x, y] of points) area += `L ${x} ${y} `;
  area += `L ${points[points.length - 1][0]} ${h} Z`;
  let line = `M ${points[0][0]} ${points[0][1]} `;
  for (let i = 1; i < points.length; i++) line += `L ${points[i][0]} ${points[i][1]} `;
  const gradId = (svg.id || 'g') + '-grad';
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

// ---------- sidebar (shared) ----------

const sidebarState = {
  sessions: [],
  search: '',
  collapsed: new Set(),
  activeId: null,
  onSelect: null, // callback when a session is clicked
};

export function getActiveSidebarId() {
  return sidebarState.activeId;
}

export function setActiveSidebarId(id) {
  sidebarState.activeId = id;
  renderSidebarSessions();
}

export async function loadSidebarSessions() {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    sidebarState.sessions = await r.json();
    renderSidebarSessions();
    return sidebarState.sessions;
  } catch (e) {
    const list = $('session-list');
    if (list) list.textContent = 'error: ' + e.message;
    return [];
  }
}

function sessionMatchesSearch(s, q) {
  if (!q) return true;
  const hay = [s.title, s.cwd, s.model, s.id, s.subagent_info?.description, s.subagent_info?.type]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

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
  for (const [, children] of childrenOf) children.sort((a, b) => b.last_active - a.last_active);
  return { roots, childrenOf };
}

function filteredSidebarSessions() {
  const q = sidebarState.search.trim().toLowerCase();
  if (!q) return sidebarState.sessions;
  const { childrenOf } = buildSessionTree(sidebarState.sessions);
  const keep = new Set();
  const markUp = (id) => {
    if (keep.has(id)) return;
    keep.add(id);
    const s = sidebarState.sessions.find((x) => x.id === id);
    if (s?.parent_id) markUp(s.parent_id);
  };
  for (const s of sidebarState.sessions) {
    if (sessionMatchesSearch(s, q)) markUp(s.id);
  }
  let added = true;
  while (added) {
    added = false;
    for (const [pid, kids] of childrenOf) {
      if (!keep.has(pid)) continue;
      for (const k of kids) if (!keep.has(k.id)) { keep.add(k.id); added = true; }
    }
  }
  return sidebarState.sessions.filter((s) => keep.has(s.id));
}

export function renderSidebarSessions() {
  const root = $('session-list');
  const cnt = $('sidebar-count');
  if (!root) return;
  root.innerHTML = '';
  const list = filteredSidebarSessions();
  if (cnt) cnt.textContent = list.length;
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = sidebarState.search ? 'no matches' : 'no sessions found';
    root.appendChild(d);
    return;
  }
  const { roots, childrenOf } = buildSessionTree(list);

  const renderNode = (s, depth) => {
    const kids = childrenOf.get(s.id) || [];
    const isCollapsed = sidebarState.collapsed.has(s.id);
    const isSubagent = !!s.parent_id;
    const info = s.subagent_info || null;

    const a = document.createElement('a');
    a.className = 'sess-item';
    a.href = `/session.html?id=${encodeURIComponent(s.id)}`;
    if (s.id === sidebarState.activeId) a.classList.add('active');
    if (isSubagent) a.classList.add('subagent');
    if (s.is_worktree && !isSubagent) a.classList.add('worktree');
    a.style.setProperty('--depth', String(depth));
    a.addEventListener('click', (ev) => {
      if (ev.target.closest('.sess-chevron')) {
        ev.preventDefault();
        return;
      }
      if (sidebarState.onSelect) {
        sidebarState.onSelect(s.id, ev);
      }
    });

    const head = document.createElement('div');
    head.className = 'sess-head';

    if (kids.length) {
      const chev = document.createElement('span');
      chev.className = 'sess-chevron' + (isCollapsed ? ' collapsed' : '');
      chev.textContent = isCollapsed ? '▶' : '▼';
      chev.title = isCollapsed ? 'Expand subagents' : 'Collapse subagents';
      chev.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (sidebarState.collapsed.has(s.id)) sidebarState.collapsed.delete(s.id);
        else sidebarState.collapsed.add(s.id);
        renderSidebarSessions();
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
    t.textContent = isSubagent && info?.description ? info.description : (s.title || '(untitled)');

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
    const kidCount = !isSubagent && kids.length ? ` · ${kids.length} subagent${kids.length > 1 ? 's' : ''}` : '';
    m.textContent = `${s.model || '?'} · ${s.num_messages || 0} msgs · ${fmtAgo(s.last_active)}${kidCount}`;

    titleWrap.append(t, sub, m);
    head.appendChild(titleWrap);
    a.appendChild(head);
    root.appendChild(a);

    if (!isCollapsed) {
      for (const k of kids) renderNode(k, depth + 1);
    }
  };

  for (const r of roots) renderNode(r, 0);
}

export function wireSidebar({ onSelect } = {}) {
  sidebarState.onSelect = onSelect || null;
  const input = $('session-search');
  const clear = $('session-search-clear');
  if (!input) return;
  const apply = () => {
    sidebarState.search = input.value;
    clear.hidden = !input.value;
    renderSidebarSessions();
  };
  input.addEventListener('input', apply);
  clear.addEventListener('click', () => {
    input.value = '';
    apply();
    input.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
  });
}

export function setLive(on, text) {
  const dot = $('live-dot');
  const txt = $('live-text');
  if (on) dot?.classList.add('on');
  else dot?.classList.remove('on');
  if (text && txt) txt.textContent = text;
}
