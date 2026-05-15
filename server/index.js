// Grok dashboard API server.
// Reads telemetry from ~/.grok/sessions and ~/.grok-tap and exposes
// JSON + SSE endpoints for the frontend.

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PORT = Number(process.env.PORT || 4173);
const HOME = os.homedir();
const GROK_HOME = process.env.GROK_HOME || path.join(HOME, '.grok');
const SESSIONS_ROOT = path.join(GROK_HOME, 'sessions');
const WORKTREES_PREFIX = path.join(GROK_HOME, 'worktrees');
const TAP_ROOT = path.join(HOME, '.grok-tap');
const TAP_INDEX = path.join(TAP_ROOT, 'index.jsonl');
const TOKEN_WINDOW_SEC = 30.0;
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB - stream instead of read whole

// ------------ helpers ------------

function decodeCwd(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function isoToEpoch(ts) {
  if (!ts) return 0;
  try {
    const d = new Date(ts);
    const n = d.getTime();
    return Number.isFinite(n) ? n / 1000 : 0;
  } catch {
    return 0;
  }
}

function extBucket(filePath) {
  const base = path.basename(filePath || '');
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '(none)';
  return base.slice(dot + 1).toLowerCase();
}

async function safeStat(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

// Read JSONL line-by-line, streaming for large files.
async function* iterJsonl(filePath) {
  const st = await safeStat(filePath);
  if (!st) return;
  if (st.size <= LARGE_FILE_THRESHOLD) {
    let text;
    try {
      text = await fsp.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        yield JSON.parse(t);
      } catch {
        // skip malformed
      }
    }
    return;
  }
  // Stream large files
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t);
    } catch {
      // skip
    }
  }
}

async function readJson(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Latest mtime across *.jsonl files (and summary.json fallback).
async function sessionLastActive(sessDir) {
  let latest = 0;
  let entries;
  try {
    entries = await fsp.readdir(sessDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl') && name !== 'summary.json') continue;
    const st = await safeStat(path.join(sessDir, name));
    if (st && st.mtimeMs / 1000 > latest) latest = st.mtimeMs / 1000;
  }
  return latest;
}

// Parse subagent metadata records for a session.
async function readSubagentMetas(sessPath) {
  const dir = path.join(sessPath, 'subagents');
  const st = await safeStat(dir);
  if (!st) return [];
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readJson(path.join(dir, e.name, 'meta.json'));
    if (!meta) continue;
    out.push(meta);
  }
  return out;
}

async function listSessions() {
  const out = [];
  let cwdDirs;
  try {
    cwdDirs = await fsp.readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of cwdDirs) {
    if (!d.isDirectory()) continue;
    const cwd = decodeCwd(d.name);
    const cwdPath = path.join(SESSIONS_ROOT, d.name);
    let sessDirs;
    try {
      sessDirs = await fsp.readdir(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessDirs) {
      if (!s.isDirectory()) continue;
      const sessPath = path.join(cwdPath, s.name);
      const summary = await readJson(path.join(sessPath, 'summary.json'));
      if (!summary) continue;
      const lastActive = await sessionLastActive(sessPath);
      const subagentMetas = await readSubagentMetas(sessPath);
      out.push({
        id: s.name,
        cwd,
        path: sessPath,
        model: summary.current_model_id || '',
        title:
          summary.generated_title ||
          summary.session_summary ||
          '',
        num_messages: summary.num_messages || 0,
        num_chat_messages: summary.num_chat_messages || 0,
        created_at: summary.created_at || '',
        updated_at: summary.updated_at || '',
        last_active: lastActive,
        subagent_metas: subagentMetas, // raw records from this session's own subagents/ dir
      });
    }
  }
  // Annotate parent/child relationships.
  // Each subagent meta carries parent_session_id and child_session_id (which can equal the
  // subagent uuid). Build a reverse index from child -> {parent, meta} and then stamp each
  // session with parent_id + the meta describing how its parent spawned it.
  const childIndex = new Map();
  for (const s of out) {
    for (const meta of s.subagent_metas || []) {
      const child = meta.child_session_id || meta.subagent_id;
      if (child && !childIndex.has(child)) {
        childIndex.set(child, { parent_id: s.id, meta });
      }
    }
  }
  for (const s of out) {
    const link = childIndex.get(s.id);
    if (link) {
      s.parent_id = link.parent_id;
      s.subagent_info = {
        type: link.meta.subagent_type || null,
        description: link.meta.description || null,
        status: link.meta.status || null,
        duration_ms: link.meta.duration_ms || 0,
        turns: link.meta.turns || 0,
        tool_calls: link.meta.tool_calls || 0,
        child_cwd: link.meta.child_cwd || null,
      };
    }
  }
  // Sort: most-recent first, but children stay attached to their parents on the client.
  out.sort((a, b) => b.last_active - a.last_active);
  return out;
}

async function pickActiveSession() {
  const all = await listSessions();
  if (all.length === 0) return null;
  const primary = all.filter((s) => !s.cwd.startsWith(WORKTREES_PREFIX));
  return (primary.length ? primary : all)[0];
}

async function findSessionById(id) {
  const all = await listSessions();
  return all.find((s) => s.id === id || s.id.startsWith(id)) || null;
}

// ------------ stats collector ------------

async function collectStats(sess) {
  const stats = {
    meta: {
      id: sess.id,
      cwd: sess.cwd,
      model: sess.model,
      title: sess.title,
      created_at: sess.created_at,
      updated_at: sess.updated_at,
      num_messages: sess.num_messages,
      num_chat_messages: sess.num_chat_messages,
      last_active: sess.last_active,
    },
    loc: {
      lines_added: 0,
      lines_removed: 0,
      net_added: 0,
      net_removed: 0,
      files_touched: 0,
      by_ext: [],
      recent_edits: [],
    },
    flow: {
      turns_started: 0,
      turns_ended: 0,
      turns_error: 0,
      tools_started: 0,
      tools_completed: 0,
      permission_prompts: 0,
      first_token_events: 0,
      current_tool: null,
      current_phase: null,
      last_event_ts: 0,
    },
    tokens: {
      last_total_tokens: 0,
      peak_total_tokens: 0,
      tokens_per_sec: 0,
      samples: 0,
    },
    tools: [], // {name, count}
  };

  const sessDirStr = sess.path;
  const filesTouched = new Set();
  const byExtAdded = {};
  const recentEdits = [];

  // hunk_records.jsonl
  for await (const h of iterJsonl(path.join(sess.path, 'hunk_records.jsonl'))) {
    const fp = h.filePath || '';
    if (!fp) continue;
    // skip session-internal files (e.g., plan.md inside the session dir)
    if (fp.startsWith(sessDirStr)) continue;
    const added = Number(h.linesAdded || 0);
    const removed = Number(h.linesRemoved || 0);
    const eventType = h.eventType || 'added';
    stats.loc.net_added += added;
    stats.loc.net_removed += removed;
    if (eventType === 'added') {
      stats.loc.lines_added += added;
      stats.loc.lines_removed += removed;
      filesTouched.add(fp);
      const ext = extBucket(fp);
      byExtAdded[ext] = (byExtAdded[ext] || 0) + added;
    }
    recentEdits.push({
      filePath: fp,
      linesAdded: added,
      linesRemoved: removed,
      eventType,
      authorType: h.authorType || 'unknown',
      timestamp: h.timestamp || '',
    });
  }
  stats.loc.files_touched = filesTouched.size;
  stats.loc.by_ext = Object.entries(byExtAdded)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => ({ ext, lines: count }));
  // Keep last 10 in chronological order (already roughly in order due to jsonl append)
  stats.loc.recent_edits = recentEdits.slice(-10).reverse();

  // events.jsonl
  const toolCounts = {};
  for await (const e of iterJsonl(path.join(sess.path, 'events.jsonl'))) {
    const etype = e.type || '';
    const ets = isoToEpoch(e.ts);
    if (ets > stats.flow.last_event_ts) stats.flow.last_event_ts = ets;
    if (etype === 'turn_started') stats.flow.turns_started += 1;
    else if (etype === 'turn_ended') {
      stats.flow.turns_ended += 1;
      if (e.outcome === 'error') stats.flow.turns_error += 1;
    } else if (etype === 'tool_started') {
      stats.flow.tools_started += 1;
      const name = e.tool || e.tool_name || e.name || '?';
      toolCounts[name] = (toolCounts[name] || 0) + 1;
      stats.flow.current_tool = name;
    } else if (etype === 'tool_completed') {
      stats.flow.tools_completed += 1;
      if (stats.flow.tools_started === stats.flow.tools_completed) {
        stats.flow.current_tool = null;
      }
    } else if (etype === 'permission_requested') {
      stats.flow.permission_prompts += 1;
    } else if (etype === 'first_token') {
      stats.flow.first_token_events += 1;
    } else if (etype === 'phase_changed') {
      stats.flow.current_phase = e.phase || e.to || stats.flow.current_phase;
    }
  }

  // updates.jsonl - token totals and tool names
  const tokenSamples = []; // [ts_s, total]
  for await (const u of iterJsonl(path.join(sess.path, 'updates.jsonl'))) {
    const ts = u.timestamp;
    let tsS = 0;
    if (typeof ts === 'number') {
      tsS = ts > 1e12 ? ts / 1000.0 : ts;
    }
    const params = u.params || {};
    const meta = params._meta || {};
    const tt = meta.totalTokens;
    if (typeof tt === 'number' && tt > 0) {
      stats.tokens.last_total_tokens = tt;
      if (tt > stats.tokens.peak_total_tokens) stats.tokens.peak_total_tokens = tt;
      if (tsS > 0) tokenSamples.push([tsS, tt]);
    }
    const upd = params.update || {};
    if (upd.sessionUpdate === 'tool_call') {
      const tname = upd.title || upd.kind || upd.toolName;
      if (tname && !(tname in toolCounts)) {
        toolCounts[tname] = toolCounts[tname] || 0;
      }
    }
  }

  stats.tokens.samples = tokenSamples.length;
  if (tokenSamples.length >= 2) {
    const lastTs = tokenSamples[tokenSamples.length - 1][0];
    const cutoff = lastTs - TOKEN_WINDOW_SEC;
    const window = tokenSamples.filter(([t]) => t >= cutoff);
    if (window.length >= 2) {
      const [t0, v0] = window[0];
      const [t1, v1] = window[window.length - 1];
      const dt = t1 - t0;
      const dv = v1 - v0;
      if (dt > 0 && dv >= 0) {
        stats.tokens.tokens_per_sec = dv / dt;
      }
    }
  }

  stats.tools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Pull input/output token breakdown from tap captures for this session.
  try {
    const usage = await usageForSession(sess);
    let inSum = 0, outSum = 0, cachedSum = 0, reasoningSum = 0, costSum = 0;
    for (const u of usage) {
      inSum += u.input_tokens;
      outSum += u.output_tokens;
      cachedSum += u.cached_tokens;
      reasoningSum += u.reasoning_tokens;
      costSum += u.cost_usd;
    }
    stats.usage = {
      calls: usage.length,
      input_tokens: inSum,
      output_tokens: outSum,
      cached_tokens: cachedSum,
      reasoning_tokens: reasoningSum,
      cost_usd: costSum,
      per_call: usage.map((u) => ({
        tag: u.tag,
        ts: u.ts,
        input: u.input_tokens,
        output: u.output_tokens,
        cached: u.cached_tokens,
        reasoning: u.reasoning_tokens,
        cost_usd: u.cost_usd,
        turn: u.turn_idx,
      })),
    };
  } catch {
    stats.usage = { calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, cost_usd: 0, per_call: [] };
  }

  return stats;
}

// ------------ captures ------------

async function readCaptures(limit = 100) {
  const exists = await safeStat(TAP_INDEX);
  if (!exists) return [];
  const rows = [];
  for await (const row of iterJsonl(TAP_INDEX)) {
    rows.push(row);
  }
  return rows.slice(-limit).reverse();
}

// Cache parsed usage per tap capture tag.
const usageCache = new Map(); // tag -> { ...usage, mtimeMs }

function extractHeader(reqText, name) {
  const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  const m = reqText.match(re);
  return m ? m[1].trim() : null;
}

function extractCwdFromReqBody(reqText) {
  // body section starts after "--- body ---"
  const idx = reqText.indexOf('--- body ---');
  if (idx < 0) return null;
  const body = reqText.slice(idx + 12).trim();
  if (!body || body[0] !== '{') return null;
  try {
    const obj = JSON.parse(body);
    const input = obj.input || [];
    for (const it of input) {
      const c = it.content;
      if (typeof c === 'string' && c.includes('Workspace Path')) {
        const m = c.match(/Workspace Path:\s*(\S+)/);
        if (m) return m[1];
      }
    }
  } catch {
    // truncated body or non-JSON
  }
  return null;
}

function extractLastDataEvent(respText, predicate) {
  // Walk SSE lines from the end backward; return first matching JSON.
  const lines = respText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (predicate(obj)) return obj;
    } catch {
      // skip
    }
  }
  return null;
}

async function parseUsageForTag(tag, indexRow) {
  const reqPath = path.join(TAP_ROOT, `${tag}-req.txt`);
  const respPath = path.join(TAP_ROOT, `${tag}-resp.txt`);
  const reqStat = await safeStat(reqPath);
  const respStat = await safeStat(respPath);
  if (!reqStat || !respStat) return null;
  const mtimeMs = Math.max(reqStat.mtimeMs, respStat.mtimeMs);
  const cached = usageCache.get(tag);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let reqText, respText;
  try {
    reqText = await fsp.readFile(reqPath, 'utf8');
    respText = await fsp.readFile(respPath, 'utf8');
  } catch {
    return null;
  }
  const sessionId = extractHeader(reqText, 'x-grok-session-id');
  const turnIdx = extractHeader(reqText, 'x-grok-turn-idx');
  const cwd = extractCwdFromReqBody(reqText);
  const completed = extractLastDataEvent(respText, (o) => o.type === 'response.completed');
  const usage = completed?.response?.usage || null;
  if (!usage) {
    const negative = { tag, mtimeMs, has_usage: false };
    usageCache.set(tag, negative);
    return negative;
  }
  const record = {
    tag,
    mtimeMs,
    has_usage: true,
    ts: indexRow?.ts || tag.split('-')[0],
    session_id: sessionId,
    turn_idx: turnIdx,
    cwd,
    input_tokens: Number(usage.input_tokens || 0),
    cached_tokens: Number(usage.input_tokens_details?.cached_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0),
    reasoning_tokens: Number(usage.output_tokens_details?.reasoning_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
    cost_in_usd_ticks: Number(usage.cost_in_usd_ticks || 0),
    cost_usd: Number(usage.cost_in_usd_ticks || 0) / 1e9,
    elapsed_ms: indexRow?.elapsed_ms || 0,
  };
  usageCache.set(tag, record);
  return record;
}

async function listAllUsage() {
  // Read tap index, return parsed usage records for each /v1/responses 200 call.
  const exists = await safeStat(TAP_INDEX);
  if (!exists) return [];
  const out = [];
  for await (const row of iterJsonl(TAP_INDEX)) {
    if (row.path !== '/v1/responses' || Number(row.status) !== 200) continue;
    const rec = await parseUsageForTag(row.tag, row);
    if (rec && rec.has_usage) out.push(rec);
  }
  return out;
}

async function usageForSession(sess) {
  // Match by x-grok-session-id first (most reliable), fall back to cwd.
  const all = await listAllUsage();
  const byId = all.filter((u) => u.session_id === sess.id);
  if (byId.length) return byId;
  return all.filter((u) => u.cwd === sess.cwd);
}

// ------------ express app ------------

const app = express();
app.use(cors());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: PORT, grok_home: GROK_HOME });
});

app.get('/api/sessions', async (_req, res) => {
  try {
    const sessions = await listSessions();
    res.json(
      sessions.map((s) => ({
        id: s.id,
        cwd: s.cwd,
        model: s.model,
        title: s.title,
        last_active: new Date(s.last_active * 1000).toISOString(),
        num_messages: s.num_messages,
        is_worktree: s.cwd.startsWith(WORKTREES_PREFIX),
        parent_id: s.parent_id || null,
        subagent_info: s.subagent_info || null,
        subagent_count: (s.subagent_metas || []).length,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

app.get('/api/session/:id', async (req, res) => {
  try {
    const sess = await findSessionById(req.params.id);
    if (!sess) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const stats = await collectStats(sess);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

app.get('/api/active', async (_req, res) => {
  try {
    const sess = await pickActiveSession();
    if (!sess) {
      res.status(404).json({ error: 'no active session' });
      return;
    }
    const stats = await collectStats(sess);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

app.get('/api/usage', async (_req, res) => {
  try {
    const all = await listAllUsage();
    // Aggregate per session_id (or cwd as fallback key)
    const bucket = new Map();
    for (const u of all) {
      const key = u.session_id || u.cwd || 'unknown';
      if (!bucket.has(key)) {
        bucket.set(key, {
          key,
          session_id: u.session_id,
          cwd: u.cwd,
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          reasoning_tokens: 0,
          cost_usd: 0,
          first_ts: u.ts,
          last_ts: u.ts,
        });
      }
      const b = bucket.get(key);
      b.calls += 1;
      b.input_tokens += u.input_tokens;
      b.output_tokens += u.output_tokens;
      b.cached_tokens += u.cached_tokens;
      b.reasoning_tokens += u.reasoning_tokens;
      b.cost_usd += u.cost_usd;
      if (u.ts < b.first_ts) b.first_ts = u.ts;
      if (u.ts > b.last_ts) b.last_ts = u.ts;
    }
    res.json({
      total_calls: all.length,
      total_input: all.reduce((s, u) => s + u.input_tokens, 0),
      total_output: all.reduce((s, u) => s + u.output_tokens, 0),
      total_cost_usd: all.reduce((s, u) => s + u.cost_usd, 0),
      sessions: Array.from(bucket.values()).sort((a, b) => b.cost_usd - a.cost_usd),
      calls: all,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

app.get('/api/captures', async (_req, res) => {
  try {
    const rows = await readCaptures(100);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// Server-Sent Events stream of the currently active session's stats.
// Optional ?id=<session-id> pins to a specific session.
app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const requestedId = req.query.id ? String(req.query.id) : null;
  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const send = (data) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial event
  send({ type: 'hello', ts: Date.now() });

  const tick = async () => {
    if (closed) return;
    try {
      const sess = requestedId
        ? await findSessionById(requestedId)
        : await pickActiveSession();
      if (sess) {
        const stats = await collectStats(sess);
        send({ type: 'stats', stats });
      } else {
        send({ type: 'no_session' });
      }
    } catch (err) {
      send({ type: 'error', error: String(err && err.message || err) });
    }
  };

  await tick();
  const handle = setInterval(tick, 1000);
  req.on('close', () => {
    clearInterval(handle);
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[grok-dashboard] api listening on http://127.0.0.1:${PORT}`);
  console.log(`[grok-dashboard] GROK_HOME=${GROK_HOME}`);
});
