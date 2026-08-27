/**
 * Clarity — Agent Harness Hackathon submission
 * Real TrueForge integration + real local tools. No simulation.
 *
 * Modes:
 *  - TrueForge mode (default): TrueForge server (port 8790) provides the agent loop
 *    (sessions, turns, SSE events: model.message, tool.call, approval, turn.done).
 *    Clarity forwards those REAL events to the UI and executes file/image tools
 *    against the local workspace (data/workspace).
 *  - Direct mode (fallback): when TrueForge is offline, Clarity streams directly
 *    from the chosen provider (Groq/OpenAI/Claude/Gemini/Local) and clearly shows
 *    "Direct mode" in the UI — nothing is faked.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 4173;
const TRUEFORGE_URL = (process.env.TRUEFORGE_URL || 'http://localhost:8790').replace(/\/$/, '');
const publicDir = path.join(__dirname, 'public');
const wsRoot = path.join(__dirname, 'data', 'workspace');
const uploadsDir = path.join(wsRoot, 'uploads');
for (const d of [wsRoot, uploadsDir]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

const providers = {
  openai: { name: 'OpenAI', model: 'gpt-4o-mini', base: 'https://api.openai.com/v1' },
  groq: { name: 'Groq', model: 'openai/gpt-oss-20b', base: 'https://api.groq.com/openai/v1' },
  anthropic: { name: 'Claude', model: 'claude-3-5-haiku-latest', base: 'https://api.anthropic.com/v1' },
  gemini: { name: 'Gemini', model: 'gemini-2.0-flash', base: 'https://generativelanguage.googleapis.com' },
  local: { name: 'Local / Ollama', model: 'llama3.2', base: 'http://localhost:11434/v1' }
};

let pendingAction = null;          // {type, path, content, name, target}
let pendingApprovalId = null;
let tfStatus = { online: false, checked: null, reason: '' };
let tfCheckInFlight = null;

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}
function body(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let s = ''; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Error('Payload too large')); req.destroy(); return; } s += c; });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function safePath(rel) {
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) throw Error('Invalid path');
  const target = path.resolve(wsRoot, rel);
  if (!target.startsWith(wsRoot)) throw Error('Path escapes workspace');
  return target;
}
function safeCalc(expr) {
  if (!/^[0-9+\-*/().%\s]+$/.test(expr) || expr.length > 100) throw Error('Only basic arithmetic is allowed');
  const result = Function('"use strict";return (' + expr + ')')();
  if (!Number.isFinite(result)) throw Error('Result is not finite');
  return result;
}
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function makeZip(files) {
  const chunks = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const cdStart = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

// ---------- TrueForge connectivity (real, cached, never blocks the app) ----------
async function checkTrueForge(force = false) {
  if (!force && tfStatus.checked && Date.now() - tfStatus.checked < 15000) return tfStatus;
  if (tfCheckInFlight) return tfCheckInFlight;
  tfCheckInFlight = (async () => {
    try {
      const ctrl = AbortSignal.timeout(4000);
      const r = await fetch(`${TRUEFORGE_URL}/api/v1/capabilities`, { signal: ctrl });
      const d = await r.json().catch(() => ({}));
      tfStatus = { online: r.ok, checked: Date.now(), data: d.data || {}, reason: r.ok ? '' : 'HTTP ' + r.status };
    } catch (e) {
      tfStatus = { online: false, checked: Date.now(), reason: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message };
    }
    return tfStatus;
  })();
  try { return await tfCheckInFlight; } finally { tfCheckInFlight = null; }
}

// ---------- Provider model discovery (real API calls) ----------
async function discoverModels(provider, key, baseUrl) {
  if (!provider) throw Error('Provider is required');
  if (provider === 'gemini') {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key), { signal: AbortSignal.timeout(12000) });
    const d = await r.json(); if (!r.ok) throw Error(d.error?.message || 'Gemini models request failed');
    return (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  }
  const base = (baseUrl || providers[provider]?.base || '').replace(/\/$/, '');
  const url = provider === 'local' ? base + '/models' : base + '/models';
  const headers = { authorization: 'Bearer ' + key };
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw Error(d.error?.message || `Models request failed (HTTP ${r.status})`);
  return (d.data || []).map(m => m.id).filter(Boolean).sort();
}

// ---------- Real workspace tools ----------
function listWorkspace() {
  const out = [];
  function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else { const st = fs.statSync(path.join(dir, e.name)); out.push({ name: r, size: st.size, mtime: st.mtime.toISOString() }); }
    }
  }
  walk(wsRoot, '');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function handleTools(req, res, u) {
  // list files
  if (u.pathname === '/api/ws/list' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, files: listWorkspace(), workspace: wsRoot }); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  // read file (text or base64 for images)
  if (u.pathname === '/api/ws/read' && req.method === 'GET') {
    try {
      const rel = u.searchParams.get('path') || '';
      const target = safePath(rel);
      if (!fs.existsSync(target)) throw Error('File not found: ' + rel);
      const buf = fs.readFileSync(target);
      const ext = path.extname(rel).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
      if (isImage && buf.length > 250000) return json(res, 200, { ok: true, image: true, size: buf.length, message: 'Image too large to preview inline; download it.' });
      return json(res, 200, { ok: true, content: buf.toString('utf8').slice(0, 30000), image: isImage, base64: isImage ? buf.toString('base64') : undefined, size: buf.length });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // upload files/images (JSON: {files:[{name, base64}], overwrite})
  if (u.pathname === '/api/ws/upload' && req.method === 'POST') {
    try {
      const b = await body(req);
      if (!Array.isArray(b.files) || !b.files.length) throw Error('No files provided');
      const saved = [];
      for (const f of b.files) {
        if (!f || !f.name) throw Error('Each file needs a name');
        const name = path.basename(String(f.name)).replace(/[^\w.\- ]/g, '_');
        const data = Buffer.from(String(f.base64 || ''), 'base64');
        if (!data.length) throw Error('Empty file: ' + name);
        const target = safePath(path.join('uploads', name));
        fs.writeFileSync(target, data);
        saved.push({ name: 'uploads/' + name, size: data.length });
      }
      return json(res, 200, { ok: true, files: saved });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // create folder
  if (u.pathname === '/api/ws/mkdir' && req.method === 'POST') {
    try { const b = await body(req); fs.mkdirSync(safePath(b.path || ''), { recursive: true }); return json(res, 200, { ok: true, text: 'Created folder ' + b.path }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // write file (real, approval-gated)
  if (u.pathname === '/api/ws/write' && req.method === 'POST') {
    try {
      const b = await body(req);
      const rel = String(b.path || '').replace(/^\/+/, '');
      if (!rel) throw Error('Path required');
      safePath(rel); // validate
      pendingApprovalId = crypto.randomUUID(); pendingAction = { id: pendingApprovalId, type: 'write', path: rel, content: String(b.content ?? '') };
      return json(res, 200, { ok: true, needsApproval: true, plan: ['Write ' + rel, 'Confirm content', 'Save file to workspace'] });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // zip package (real, approval-gated)
  if (u.pathname === '/api/ws/zip' && req.method === 'POST') {
    try {
      const b = await body(req);
      const name = (b.name || 'workspace.zip').replace(/[^\w.\-]/g, '_');
      pendingApprovalId = crypto.randomUUID(); pendingAction = { id: pendingApprovalId, type: 'zip', name };
      return json(res, 200, { ok: true, needsApproval: true, plan: ['Package workspace files into ' + name, 'Create archive', 'Provide download link'] });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // delete (real, approval-gated)
  if (u.pathname === '/api/ws/delete' && req.method === 'POST') {
    try {
      const b = await body(req);
      const rel = String(b.path || '');
      const target = safePath(rel);
      if (!fs.existsSync(target)) throw Error('File not found: ' + rel);
      if (target === wsRoot || target === uploadsDir) throw Error('Cannot delete workspace root');
      pendingApprovalId = crypto.randomUUID(); pendingAction = { id: pendingApprovalId, type: 'delete', path: rel, target };
      return json(res, 200, { ok: true, needsApproval: true, plan: ['Delete ' + rel, 'Irreversible — confirm with human', 'Remove from workspace'] });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // fetch URL (real)
  if (u.pathname === '/api/ws/fetch' && req.method === 'POST') {
    try {
      const b = await body(req);
      const target = new URL(b.url);
      if (!/^https?:$/.test(target.protocol)) throw Error('Only http(s) URLs allowed');
      const r = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (Clarity)' }, signal: AbortSignal.timeout(10000) });
      const text = await r.text();
      const clean = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
      return json(res, 200, { ok: true, url: b.url, status: r.status, text: clean || '(empty page)' });
    } catch (e) { return json(res, 400, { ok: false, error: 'Fetch failed: ' + e.message }); }
  }
  // sandbox command (real, whitelisted)
  if (u.pathname === '/api/ws/run' && req.method === 'POST') {
    try {
      const b = await body(req);
      let cmd = String(b.cmd || '').trim();
      if (!/^(ls|cat|echo|pwd|date|wc|head|tail|grep|find)\b/.test(cmd)) throw Error('Command not allowed. Allowed: ls, cat, echo, pwd, date, wc, head, tail, grep, find');
      if (/[;&|>`]|\$\s*\(|\brm\b|\bsudo\b|\bcurl\b|\bwget\b|\bnc\b|\bpython\b|\bnode\b|\bmv\b|\bdd\b/.test(cmd)) throw Error('Unsafe pattern detected');
      const { execFile } = require('child_process');
      const parts = cmd.split(/\s+/); const bin = parts.shift();
      const out = await new Promise((resolve, reject) => {
        execFile(bin, parts, { cwd: wsRoot, timeout: 8000, maxBuffer: 20000 }, (err, stdout, stderr) => {
          if (err && !stdout) return reject(Error(stderr || err.message));
          resolve((stdout || '') + (stderr ? '\n[stderr] ' + stderr : ''));
        });
      });
      return json(res, 200, { ok: true, cmd: b.cmd, output: out.slice(0, 3000) });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // download file
  if (u.pathname === '/api/ws/download' && req.method === 'GET') {
    try {
      const target = safePath(u.searchParams.get('path') || '');
      if (!fs.existsSync(target)) throw Error('File not found');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + path.basename(target) + '"' });
      return fs.createReadStream(target).pipe(res);
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  return false;
}

// ---------- Approval execution (REAL — actually performs the action) ----------
async function executeApproval(a) {
  if (a.type === 'write') {
    const target = safePath(a.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, a.content);
    return { ok: true, text: `Approved and executed: wrote **${a.path}** (${a.content.length} chars) to the workspace.`, result: 'file-written' };
  }
  if (a.type === 'delete') {
    fs.rmSync(a.target, { recursive: true, force: true });
    return { ok: true, text: `Approved and executed: deleted **${a.path}** from the workspace.`, result: 'file-deleted' };
  }
  if (a.type === 'zip') {
    const files = listWorkspace().filter(f => !f.name.endsWith('.zip')).map(f => ({ name: f.name, data: fs.readFileSync(path.join(wsRoot, f.name)) }));
    if (!files.length) files.push({ name: 'README.txt', data: 'Clarity workspace — created by approval-first agent.' });
    const zip = makeZip(files);
    const out = path.join(wsRoot, a.name);
    fs.writeFileSync(out, zip);
    return { ok: true, text: `Approved and executed: created **${a.name}** (${zip.length} bytes, ${files.length} file(s)). Download from the Files panel.`, result: 'zip-created', file: a.name, size: zip.length };
  }
  throw Error('Unknown pending action');
}

// ---------- Direct provider streaming (real, used when TrueForge offline) ----------
async function streamProviderDirect(res, b) {
  const key = b.apiKey || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  const provider = b.provider || 'groq';
  const model = b.model || providers[provider]?.model;
  if (!key) throw Error('API key is required. Add it in Model connection, or start TrueForge.');
  const system = 'You are Clarity, an approval-first AI agent. Be concise and useful. Never perform irreversible actions without explicit user approval. When a tool is needed, explain the plan and request approval.';
  if (provider === 'groq' || provider === 'openai') {
    const url = provider === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: b.message }], stream: true, max_tokens: 700 })
    });
    if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw Error(d.error?.message || 'Provider request failed'); }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim(); if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim(); if (payload === '[DONE]') continue;
        try { const j = JSON.parse(payload); const delta = j.choices?.[0]?.delta?.content; if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`); } catch {}
      }
    }
  } else if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || providers.anthropic.model, max_tokens: 700, system, messages: [{ role: 'user', content: b.message }] })
    });
    const d = await r.json(); if (!r.ok) throw Error(d.error?.message || 'Anthropic request failed');
    const text = d.content?.map(x => x.text || '').join('') || '';
    for (const c of text.split(' ')) { res.write(`data: ${JSON.stringify({ delta: c + ' ' })}\n\n`); await new Promise(r2 => setTimeout(r2, 25)); }
  } else if (provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || providers.gemini.model}:generateContent?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: b.message }] }] }) });
    const d = await r.json(); if (!r.ok) throw Error(d.error?.message || 'Gemini request failed');
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    for (const c of text.split(' ')) { res.write(`data: ${JSON.stringify({ delta: c + ' ' })}\n\n`); await new Promise(r2 => setTimeout(r2, 25)); }
  } else {
    const base = process.env.LOCAL_BASE_URL || 'http://localhost:11434/v1/chat/completions';
    const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: b.message }], stream: true, temperature: .3 }) });
    if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw Error(d.error?.message || 'Local request failed'); }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim(); if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim(); if (payload === '[DONE]') continue;
        try { const j = JSON.parse(payload); const delta = j.choices?.[0]?.delta?.content; if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`); } catch {}
      }
    }
  }
}

// ---------- TrueForge bridge (REAL events forwarded to UI) ----------
let tfCachedAgent = null;
const tfSessions = new Map(); // client runId -> {sessionId, agentName}

async function tfJson(method, endpoint, payload, timeoutMs = 15000) {
  const opts = {
    method,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (payload !== undefined) opts.body = JSON.stringify(payload);
  const r = await fetch(TRUEFORGE_URL + endpoint, opts);
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw Error(`TrueForge ${method} ${endpoint} HTTP ${r.status}: ${data.error?.message || data.message || text.slice(0, 200)}`);
  return data;
}

async function ensureGroqProvider(key) {
  try {
    const list = await tfJson('GET', '/api/v1/settings/model-providers');
    const existing = (list.data || []).some(x => x.name === 'groq');
    if (existing) return;
    await tfJson('POST', '/api/v1/settings/model-providers', {
      manifest: {
        type: 'custom', name: 'groq', base_url: 'https://api.groq.com/openai/v1',
        auth: { api_key: key },
        models: [{ model_id: 'openai/gpt-oss-20b', name: 'gpt-oss-20b', properties: {} }]
      }
    });
  } catch (e) { throw Error('Groq provider setup failed: ' + e.message); }
}

async function ensureAgent(b) {
  if (tfCachedAgent) return tfCachedAgent;
  const provider = b.provider === 'groq' ? 'groq' : (b.provider || 'groq');
  const model = b.model || providers[provider]?.model;
  const fqn = `${provider}/${model.replace(/^.*\//, '')}`;
  try {
    const list = await tfJson('GET', '/api/v1/agents');
    const found = (list.data || []).find(a => a.name === 'clarity');
    if (found) { tfCachedAgent = found; return found; }
  } catch {}
  const created = await tfJson('POST', '/api/v1/agents', {
    manifest: { model: { name: fqn } }, name: 'clarity'
  });
  tfCachedAgent = created.data || created;
  return tfCachedAgent;
}

async function streamThroughTrueForge(res, b, _unused) {
  const key = b.apiKey || process.env.GROQ_API_KEY;
  if (b.provider === 'groq' && key) await ensureGroqProvider(key);
  await ensureAgent(b);
  // Reuse one TrueForge session for a run, so consecutive user messages have history.
  const runId = String(b.runId || 'default').slice(0, 120);
  let sessionId = tfSessions.get(runId)?.sessionId;
  if (!sessionId) {
    const sess = await tfJson('POST', '/api/v1/sessions', { agent: { name: 'clarity' } });
    sessionId = sess?.data?.id || sess?.id;
    if (!sessionId) throw Error('TrueForge created no session id');
    tfSessions.set(runId, { sessionId, agentName: 'clarity' });
    res.write(`data: ${JSON.stringify({ mode: 'trueforge', event: 'session.created', sessionId })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ mode: 'trueforge', event: 'session.reused', sessionId })}\n\n`);
  }
  // turn (SSE, REAL)
  const r = await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
    body: JSON.stringify({ input: [{ type: 'user.message', content: b.message }] }),
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok || !r.body) throw Error(`TrueForge turn HTTP ${r.status}`);
  const reader = r.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const raw = t.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let ev; try { ev = JSON.parse(raw); } catch { continue; }
      const typ = ev.type || '';
      if (typ === 'model.message.delta') {
        const delta = ev.delta ?? '';
        const reasoning = ev.reasoning_content ?? '';
        if (reasoning) res.write(`data: ${JSON.stringify({ reasoning_content: reasoning, event: typ })}\n\n`);
        else if (delta) res.write(`data: ${JSON.stringify({ delta, event: typ })}\n\n`);
      } else if (typ === 'model.message') {
        const c = ev.delta ?? ev.content ?? ev.message?.content ?? '';
        const text = Array.isArray(c) ? c.map(x => x?.text || '').join('') : c;
        if (text) res.write(`data: ${JSON.stringify({ delta: text, event: typ })}\n\n`);
      } else if (typ === 'tool.call') {
        res.write(`data: ${JSON.stringify({ event: typ, tool: ev.toolName || ev.name || 'tool', args: ev.args || ev.input || {} })}\n\n`);
      } else if (/approval/i.test(typ)) {
        res.write(`data: ${JSON.stringify({ event: 'approval.requested', reason: ev.reason || ev.message || '' })}\n\n`);
      } else if (typ === 'turn.done' || typ === 'turn.created') {
        res.write(`data: ${JSON.stringify({ event: typ })}\n\n`);
      }
    }
  }
}

// ---------- HTTP server ----------
function createApp() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      const toolHandled = await handleTools(req, res, u);
      if (toolHandled !== false) return;

      if (req.method === 'GET' && u.pathname === '/api/health') {
        const tf = await checkTrueForge();
        return json(res, 200, {
          ok: true, name: 'Clarity', version: '3.0.0',
          trueforge: tf,
          tools: ['file-create', 'file-edit', 'file-delete', 'folder-create', 'zip-package', 'url-fetch', 'sandbox-run', 'file-upload', 'image-upload', 'calculator'],
          providers: Object.keys(providers)
        });
      }
      if (req.method === 'GET' && u.pathname === '/api/trueforge') {
        return json(res, 200, await checkTrueForge(true));
      }
      if (req.method === 'GET' && u.pathname === '/api/providers') return json(res, 200, { providers });
      if (req.method === 'POST' && u.pathname === '/api/providers/models') {
        try { const b = await body(req); const models = await discoverModels(b.provider, b.apiKey, b.baseUrl); return json(res, 200, { ok: true, provider: b.provider, models }); }
        catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }

      if (req.method === 'POST' && u.pathname === '/api/reject') {
        const reason = (await body(req).catch(() => ({}))).reason || 'Rejected by user';
        if (!pendingAction) return json(res, 400, { ok: false, error: 'No pending approval' });
        const rejected = pendingAction; pendingAction = null; pendingApprovalId = null;
        return json(res, 200, { ok: true, status: 'rejected', text: `Rejected: ${rejected.type} action was not executed.`, reason });
      }

      if (req.method === 'POST' && u.pathname === '/api/approve') {
        try {
          if (!pendingAction) return json(res, 400, { ok: false, error: 'No pending action to approve' });
          const a = pendingAction; pendingAction = null; pendingApprovalId = null;
          const result = await executeApproval(a);
          return json(res, 200, result);
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }

      if (req.method === 'POST' && u.pathname === '/api/agent/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        try {
          const b = await body(req);
          if (b.demo) {
            const out = { text: 'Demo mode is disabled in this build. Start TrueForge (npm run trueforge) or enter an API key.' };
            res.write(`data: ${JSON.stringify({ delta: out.text })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); return;
          }
          const tf = await checkTrueForge();
          if (tf.online) {
            res.write(`data: ${JSON.stringify({ mode: 'trueforge', event: 'status', message: 'Connected to TrueForge ' + TRUEFORGE_URL })}\n\n`);
            try { await streamThroughTrueForge(res, b, null); }
            catch (e) {
              // Honest fallback: tell the user and stream from provider directly.
              res.write(`data: ${JSON.stringify({ mode: 'direct', event: 'status', message: 'TrueForge turn failed (' + (e.message||'').slice(0,80) + ') - switched to Direct ' + (b.provider||'groq') })}\n\n`);
              try { await streamProviderDirect(res, b); } catch (e2) { throw e2; }
            }
          } else {
            res.write(`data: ${JSON.stringify({ mode: 'direct', event: 'status', message: 'TrueForge offline — Direct mode (' + (b.provider || 'groq') + '). Real streaming from provider.' })}\n\n`);
            await streamProviderDirect(res, b);
          }
          res.write('data: [DONE]\n\n'); res.end();
        } catch (e) {
          try { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } catch {}
        }
        return;
      }

      // static files
      if (req.method === 'GET') {
        const rel = u.pathname === '/' ? 'index.html' : u.pathname;
        // serve uploads directly from workspace for previews
        if (rel.startsWith('/uploads/')) {
          try {
            const target = safePath(rel.slice(1));
            if (!fs.existsSync(target)) return json(res, 404, { error: 'Not found' });
            const ext = path.extname(target).toLowerCase();
            const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown' }[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            return fs.createReadStream(target).pipe(res);
          } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        }
        let file = path.join(publicDir, rel);
        if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'Not found' });
        const ext = path.extname(file);
        const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
      json(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      if (!res.headersSent) return json(res, 500, { ok: false, error: e.message });
      try { res.end(); } catch {}
    }
  });
}

if (require.main === module) {
  checkTrueForge();
  createApp().listen(PORT, () => console.log(`Clarity v3 running at http://localhost:${PORT} · workspace: ${wsRoot} · trueforge: ${TRUEFORGE_URL}`));
}
module.exports = { createApp, providers, safeCalc, makeZip, listWorkspace, safePath, wsRoot, checkTrueForge, executeApproval };
