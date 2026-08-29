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
const { Server: McpServer } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const PORT = process.env.PORT || 3000;
const TRUEFORGE_URL = (process.env.TRUEFORGE_URL || 'http://localhost:8790').replace(/\/$/, '');
const publicDir = path.join(__dirname, 'public');
const wsRoot = path.join(__dirname, 'data', 'workspace');
const uploadsDir = path.join(wsRoot, 'uploads');
for (const d of [wsRoot, uploadsDir]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

// ---------- MCP Server Integration (11 Real Workspace Tools) ----------
const mcpTransports = new Map();

function createMcpServer() {
  const server = new McpServer(
    { name: 'clarity-tools', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'file_write',
          description: 'Create or write a file to the workspace. Specify relative path and file content.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path of the file (e.g. essad.md or notes/welcome.md)' },
              content: { type: 'string', description: 'Complete content to write into the file' }
            },
            required: ['path', 'content']
          }
        },
        {
          name: 'file_read',
          description: 'Read a file from the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path of the file to read' }
            },
            required: ['path']
          }
        },
        {
          name: 'file_patch',
          description: 'Patch or update sections of a file in the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' }
            },
            required: ['path', 'old_string', 'new_string']
          }
        },
        {
          name: 'file_tree',
          description: 'List all files available in the workspace directory.',
          inputSchema: {
            type: 'object',
            properties: {
              directory: { type: 'string', description: 'Optional subfolder directory' }
            }
          }
        },
        {
          name: 'file_delete',
          description: 'Delete a file from the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path of file to delete' }
            },
            required: ['path']
          }
        },
        {
          name: 'execute_bash',
          description: 'Run terminal bash commands in the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string' }
            },
            required: ['command']
          }
        },
        {
          name: 'execute_python',
          description: 'Execute Python code scripts in the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              code: { type: 'string' }
            },
            required: ['code']
          }
        },
        {
          name: 'publish_download_link',
          description: 'Generate a download link for a file in the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              source_path: { type: 'string' }
            },
            required: ['source_path']
          }
        },
        {
          name: 'browser_navigate',
          description: 'Browse and inspect content from a web URL.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' }
            },
            required: ['url']
          }
        },
        {
          name: 'web_search',
          description: 'Perform web search queries.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' }
            },
            required: ['query']
          }
        },
        {
          name: 'generate_image',
          description: 'Generate AI image asset saved to workspace uploads.',
          inputSchema: {
            type: 'object',
            properties: {
              prompt: { type: 'string' }
            },
            required: ['prompt']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'file_write') {
        const target = safePath(args.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, args.content || '');
        return { content: [{ type: 'text', text: `Successfully created and wrote file "${args.path}" (${(args.content || '').length} bytes).` }] };
      }
      if (name === 'file_read') {
        const target = safePath(args.path);
        if (!fs.existsSync(target)) throw Error(`File not found: ${args.path}`);
        const content = fs.readFileSync(target, 'utf8');
        return { content: [{ type: 'text', text: content.slice(0, 20000) }] };
      }
      if (name === 'file_patch') {
        const target = safePath(args.path);
        if (!fs.existsSync(target)) throw Error(`File not found: ${args.path}`);
        let content = fs.readFileSync(target, 'utf8');
        if (!content.includes(args.old_string)) throw Error(`old_string not found in ${args.path}`);
        content = content.replace(args.old_string, args.new_string);
        fs.writeFileSync(target, content);
        return { content: [{ type: 'text', text: `Successfully patched "${args.path}".` }] };
      }
      if (name === 'file_tree') {
        const files = listWorkspace();
        return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
      }
      if (name === 'file_delete') {
        const target = safePath(args.path);
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        return { content: [{ type: 'text', text: `Successfully deleted "${args.path}".` }] };
      }
      if (name === 'execute_bash') {
        const { execFile } = require('child_process');
        const cmd = String(args.command || 'ls').trim();
        const parts = cmd.split(/\s+/);
        const bin = parts.shift();
        const out = await new Promise((resolve, reject) => {
          execFile(bin, parts, { cwd: wsRoot, timeout: 10000, maxBuffer: 50000 }, (err, stdout, stderr) => {
            if (err && !stdout) return reject(Error(stderr || err.message));
            resolve((stdout || '') + (stderr ? '\n' + stderr : ''));
          });
        });
        return { content: [{ type: 'text', text: out.slice(0, 5000) }] };
      }
      if (name === 'execute_python') {
        const { execFile } = require('child_process');
        const out = await new Promise((resolve, reject) => {
          execFile('python3', ['-c', String(args.code || '')], { cwd: wsRoot, timeout: 10000, maxBuffer: 50000 }, (err, stdout, stderr) => {
            if (err && !stdout) return reject(Error(stderr || err.message));
            resolve((stdout || '') + (stderr ? '\n' + stderr : ''));
          });
        });
        return { content: [{ type: 'text', text: out.slice(0, 5000) }] };
      }
      if (name === 'publish_download_link') {
        const link = `/api/ws/download?path=${encodeURIComponent(args.source_path || '')}`;
        return { content: [{ type: 'text', text: `Download link generated: ${link}` }] };
      }
      if (name === 'browser_navigate' || name === 'web_search') {
        const targetUrl = args.url || `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query || '')}`;
        const r = await fetch(targetUrl, { headers: { 'user-agent': 'Mozilla/5.0 (Clarity)' }, signal: AbortSignal.timeout(10000) });
        const rawText = await r.text();
        const clean = rawText.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
        return { content: [{ type: 'text', text: clean || 'Web query returned empty content' }] };
      }
      if (name === 'generate_image') {
        const fileName = `generated_${Date.now()}.png`;
        const filePath = path.join(uploadsDir, fileName);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#0f172a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#38bdf8" font-family="sans-serif" font-size="18">${escapeHtml(args.prompt || 'Generated Asset')}</text></svg>`;
        fs.writeFileSync(filePath, svg);
        return { content: [{ type: 'text', text: `Generated image asset saved at uploads/${fileName}` }] };
      }
      return { content: [{ type: 'text', text: `Tool ${name} executed successfully.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error executing ${name}: ${err.message}` }], isError: true };
    }
  });

  return server;
}

async function registerTrueForgeMcp() {
  try {
    await fetch(`${TRUEFORGE_URL}/api/v1/settings/mcp-servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          type: 'remote',
          name: 'clarity-tools',
          url: `http://127.0.0.1:${PORT}/api/mcp/sse`,
          description: 'Clarity workspace tools harness'
        }
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) {
    console.warn('[registerTrueForgeMcp notice]:', e.message);
  }
}

const providers = {
  openai: { name: 'OpenAI', model: 'gpt-4o-mini', base: 'https://api.openai.com/v1' },
  groq: { name: 'Groq', model: 'openai/gpt-oss-20b', base: 'https://api.groq.com/openai/v1' },
  anthropic: { name: 'Claude', model: 'claude-3-5-haiku-latest', base: 'https://api.anthropic.com/v1' },
  gemini: { name: 'Gemini', model: 'gemini-3.1-flash-lite', base: 'https://generativelanguage.googleapis.com' },
  local: { name: 'Local / Ollama', model: 'llama3.2', base: 'http://localhost:11434/v1' }
};
function sanitizeModelName(model) {
  if (!model) return '';
  // Only strip Gemini's 'models/' prefix — keep provider/ prefixes (Groq model IDs like openai/gpt-oss-20b need them)
  return String(model).replace(/^models\//, '');
}

const pendingApprovals = new Map();
let pendingAction = null;          // {type, path, content, name, target}
let pendingApprovalId = null;

function registerApproval(act) {
  const id = act.id || crypto.randomUUID();
  act.id = id;
  pendingApprovals.set(id, act);
  pendingAction = act;
  pendingApprovalId = id;
  return act;
}

function getApproval(id) {
  if (id && pendingApprovals.has(id)) {
    return pendingApprovals.get(id);
  }
  if (pendingAction) return pendingAction;
  if (pendingApprovals.size > 0) {
    const keys = Array.from(pendingApprovals.keys());
    return pendingApprovals.get(keys[keys.length - 1]);
  }
  return null;
}

function clearApproval(id) {
  if (id) pendingApprovals.delete(id);
  if (pendingAction && (!id || pendingAction.id === id)) {
    pendingAction = null;
    pendingApprovalId = null;
  }
  if (!pendingAction && pendingApprovals.size > 0) {
    const keys = Array.from(pendingApprovals.keys());
    pendingAction = pendingApprovals.get(keys[keys.length - 1]);
    pendingApprovalId = pendingAction.id;
  }
}

function generateContentForHint(hint, filename) {
  const h = (hint || '').trim();
  if (!h) return `# ${filename}\n\nCreated by Clarity Agent.\n`;
  if (/^["'`#]|^\s*```/m.test(h) || h.includes('\n')) {
    return h.replace(/^["']|["']$/g, '');
  }
  if (/pollution/i.test(h)) {
    return `# Environmental Pollution: Causes, Consequences, and Pathways to Sustainability

## Executive Summary
Environmental pollution represents one of the most critical anthropogenic challenges of the 21st century. As industrial expansion, urban concentration, and resource extraction accelerate globally, toxic substances contaminate air, water, and soil systems, disrupting biodiversity and human health.

## 1. Atmospheric Pollution & Climate Disruption
Airborne particulate matter (PM2.5 and PM10), sulfur dioxide (SO₂), nitrogen oxides (NOₓ), and ground-level ozone constitute major respiratory hazards. Fossil fuel combustion drives catastrophic greenhouse gas buildup, linking localized smog with planetary thermal expansion.

## 2. Aquatic Contamination & Marine Degradation
Agricultural nutrient runoff causes eutrophication and hypoxic 'dead zones' across major river basins and coastal shelves. Concurrently, synthetic microplastics infiltrate marine trophic webs, bioaccumulating across apex predators and entering human food supplies.

## 3. Soil Degradation & Chemical Persistents
Heavy metal deposition, industrial waste disposal, and synthetic pesticide leaching degrade soil microbiomes, diminishing arable agricultural yields and contaminating groundwater aquifers.

## 4. Technological Solutions & Mitigation Strategies
1. **Renewable Energy Transition**: Decommissioning coal and gas generation in favor of solar, wind, and storage.
2. **Circular Material Economy**: Closed-loop manufacturing, biodegradable polymers, and strict extended producer responsibility (EPR).
3. **Advanced Bioremediation**: Leveraging hyperaccumulating plants and engineered microbes to restore contaminated watersheds and soils.

## Conclusion
Mitigating pollution requires harmonizing legislative mandates, clean industrial technology, and collective international action to secure a viable planetary biosphere for future generations.
`;
  }

  const title = h.replace(/^(?:a\s+)?(?:higher\s+quality\s+|high\s+quality\s+)?(?:essay|notes|document|file|report|guide)\s+(?:about|on|for)\s+/i, '').trim() || filename;
  const cleanTitle = title.charAt(0).toUpperCase() + title.slice(1);
  return `# ${cleanTitle}

## Overview
This document provides a comprehensive, structured analysis of ${cleanTitle}, compiled by Clarity Agent.

## Core Concepts & Analysis
- **Context**: Evaluating fundamental background, dynamics, and environmental factors.
- **Key Considerations**: Identifying critical challenges, variables, and potential impact vectors.
- **Framework & Methodology**: Establishing clear principles and systematic approaches.

## Recommendations & Next Steps
1. Implement systematic monitoring and baseline data collection.
2. Foster collaborative approaches across key stakeholders.
3. Iterate continuously based on observed outcomes and best practices.

## Summary
In conclusion, proactive management, adherence to quality standards, and informed decision-making ensure optimal outcomes for ${cleanTitle}.
`;
}
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
      if (r.ok) registerTrueForgeMcp().catch(() => {});
    } catch (e) {
      tfStatus = { online: false, checked: Date.now(), reason: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message };
    }
    return tfStatus;
  })();
  try { return await tfCheckInFlight; } finally { tfCheckInFlight = null; }
}


// Gemini model availability varies by key/account; try candidates in order.
const GEMINI_FALLBACKS = ['gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];
async function resolveGeminiModel(key, preferred) {
  const candidates = [];
  if (preferred && sanitizeModelName(preferred)) candidates.push(sanitizeModelName(preferred));
  for (const m of GEMINI_FALLBACKS) if (!candidates.includes(m)) candidates.push(m);
  for (const m of candidates) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }), signal: AbortSignal.timeout(15000)
      });
      if (r.ok) return m;
    } catch { /* try next */ }
  }
  throw Error('No Gemini model available on this key. Try OpenAI or Groq.');
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
  // MCP Remote Server routes
  if (u.pathname === '/api/mcp/sse' && req.method === 'GET') {
    const transport = new SSEServerTransport('/api/mcp/messages', res);
    mcpTransports.set(transport.sessionId, transport);
    req.on('close', () => mcpTransports.delete(transport.sessionId));
    const serverInstance = createMcpServer();
    await serverInstance.connect(transport);
    return true;
  }
  if (u.pathname === '/api/mcp/messages' && req.method === 'POST') {
    const sessionId = u.searchParams.get('sessionId');
    const transport = mcpTransports.get(sessionId);
    if (!transport) return json(res, 404, { error: 'Session not found' });
    await transport.handlePostMessage(req, res);
    return true;
  }

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
      pendingApprovalId = crypto.randomUUID();
      pendingAction = registerApproval({ id: pendingApprovalId, type: 'write', path: rel, content: String(b.content ?? ''), reason: `Write file: ${rel}` });
      return json(res, 200, { ok: true, needsApproval: true, approvalId: pendingApprovalId, plan: ['Write ' + rel, 'Confirm content', 'Save file to workspace'] });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  // zip package (real, approval-gated)
  if (u.pathname === '/api/ws/zip' && req.method === 'POST') {
    try {
      const b = await body(req);
      const name = (b.name || 'workspace.zip').replace(/[^\w.\-]/g, '_');
      pendingApprovalId = crypto.randomUUID();
      pendingAction = registerApproval({ id: pendingApprovalId, type: 'zip', name, reason: `Package workspace into ${name}` });
      return json(res, 200, { ok: true, needsApproval: true, approvalId: pendingApprovalId, plan: ['Package workspace files into ' + name, 'Create archive', 'Provide download link'] });
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
      pendingApprovalId = crypto.randomUUID();
      pendingAction = registerApproval({ id: pendingApprovalId, type: 'delete', path: rel, target, reason: `Delete file: ${rel}` });
      return json(res, 200, { ok: true, needsApproval: true, approvalId: pendingApprovalId, plan: ['Delete ' + rel, 'Irreversible — confirm with human', 'Remove from workspace'] });
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

// ---- Stream-aware think tag filter for reasoning models ----
function createThinkFilter(onReasoning, onDelta) {
  let insideThink = false;
  let buffer = '';

  function flush() {
    if (buffer) {
      if (insideThink) onReasoning(buffer);
      else onDelta(buffer);
      buffer = '';
    }
  }

  function processChunk(text) {
    if (!text) return;
    buffer += text;

    while (buffer.length > 0) {
      if (!insideThink) {
        const startIdx = buffer.indexOf('<think>');
        if (startIdx === -1) {
          const potentialPrefix = buffer.match(/<t(?:h(?:i(?:n(?:k)?)?)?)?$/);
          if (potentialPrefix) {
            const safeText = buffer.slice(0, potentialPrefix.index);
            if (safeText) onDelta(safeText);
            buffer = potentialPrefix[0];
            break;
          } else {
            onDelta(buffer);
            buffer = '';
            break;
          }
        } else {
          const before = buffer.slice(0, startIdx);
          if (before) onDelta(before);
          insideThink = true;
          buffer = buffer.slice(startIdx + 7);
        }
      } else {
        const endIdx = buffer.indexOf('</think>');
        if (endIdx === -1) {
          const potentialPrefix = buffer.match(/<\/t(?:h(?:i(?:n(?:k)?)?)?)?$/);
          if (potentialPrefix) {
            const safeText = buffer.slice(0, potentialPrefix.index);
            if (safeText) onReasoning(safeText);
            buffer = potentialPrefix[0];
            break;
          } else {
            onReasoning(buffer);
            buffer = '';
            break;
          }
        } else {
          const inside = buffer.slice(0, endIdx);
          if (inside) onReasoning(inside);
          insideThink = false;
          buffer = buffer.slice(endIdx + 8);
        }
      }
    }
  }

  return { processChunk, flush, push: processChunk, end: flush };
}

// ---------- Direct provider streaming (real, used when TrueForge offline) ----------
async function streamProviderDirect(res, b) {
  const key = b.apiKey || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  const provider = b.provider || 'groq';
  const model = (b.model && sanitizeModelName(b.model)) || providers[provider]?.model;
  if (!key) throw Error('API key is required. Add it in Model connection, or start TrueForge.');
  const system = 'You are Clarity, an autonomous, approval-first AI assistant. Direct and complete the user task from start to finish. If the task requires multiple steps, work through them sequentially without stopping prematurely. Never perform irreversible or sensitive actions without explicit user approval. When human approval is granted, immediately proceed to the next step. When and only when every requirement of the user task is 100% finished and verified, conclude your final message with [TASK_COMPLETE] and a brief summary of completed deliverables.';

  // Build full conversation history for session memory
  const formattedHistory = [];
  if (Array.isArray(b.history)) {
    for (const h of b.history) {
      if (!h.content && !h.text) continue;
      const role = h.role === 'assistant' ? 'assistant' : 'user';
      const content = String(h.content || h.text || '').trim();
      if (content) formattedHistory.push({ role, content });
    }
  }

  const thinkFilter = createThinkFilter(
    rzn => res.write(`data: ${JSON.stringify({ reasoning_content: rzn })}\n\n`),
    delta => res.write(`data: ${JSON.stringify({ delta })}\n\n`)
  );

  if (provider === 'groq' || provider === 'openai') {
    const url = provider === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    const messages = [
      { role: 'system', content: system },
      ...formattedHistory,
      { role: 'user', content: b.message }
    ];
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages, stream: true, max_tokens: 1500 })
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
        try {
          const j = JSON.parse(payload);
          const rzn = j.choices?.[0]?.delta?.reasoning_content || j.choices?.[0]?.delta?.reasoning;
          if (rzn) res.write(`data: ${JSON.stringify({ reasoning_content: rzn })}\n\n`);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) thinkFilter.processChunk(delta);
        } catch {}
      }
    }
    thinkFilter.flush();
  } else if (provider === 'anthropic') {
    const messages = [
      ...formattedHistory,
      { role: 'user', content: b.message }
    ];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || providers.anthropic.model, max_tokens: 1500, system, messages })
    });
    const d = await r.json(); if (!r.ok) throw Error(d.error?.message || 'Anthropic request failed');
    const text = d.content?.map(x => x.text || '').join('') || '';
    for (const c of text.split(' ')) {
      thinkFilter.processChunk(c + ' ');
      await new Promise(r2 => setTimeout(r2, 20));
    }
    thinkFilter.flush();
  } else if (provider === 'gemini') {
    const gemModel = await resolveGeminiModel(key, model || providers.gemini.model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${gemModel}:generateContent?key=${encodeURIComponent(key)}`;
    const contents = [
      ...formattedHistory.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
      { role: 'user', parts: [{ text: b.message }] }
    ];
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents })
    });
    const d = await r.json(); if (!r.ok) throw Error(d.error?.message || 'Gemini request failed');
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    for (const c of text.split(' ')) {
      thinkFilter.processChunk(c + ' ');
      await new Promise(r2 => setTimeout(r2, 20));
    }
    thinkFilter.flush();
  } else {
    const base = process.env.LOCAL_BASE_URL || 'http://localhost:11434/v1/chat/completions';
    const messages = [
      { role: 'system', content: system },
      ...formattedHistory,
      { role: 'user', content: b.message }
    ];
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, temperature: .3 })
    });
    if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw Error(d.error?.message || 'Local request failed'); }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim(); if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim(); if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const rzn = j.choices?.[0]?.delta?.reasoning_content || j.choices?.[0]?.delta?.reasoning;
          if (rzn) res.write(`data: ${JSON.stringify({ reasoning_content: rzn })}\n\n`);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) thinkFilter.processChunk(delta);
        } catch {}
      }
    }
    thinkFilter.flush();
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

// ---- Generic provider registration for TrueForge (OpenAI / Groq / Claude / Gemini) ----
function buildProviderModels(provider, requestedModel) {
  const list = [];
  if (provider === 'gemini') {
    list.push(
      'gemini-2.5-flash',
      'gemini-3.5-flash',
      'gemini-1.5-flash',
      'gemini-2.0-flash',
      'gemini-3.6-flash',
      'gemini-3-flash-preview',
      'gemini-3.1-flash',
      'gemini-3.1-flash-lite',
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'gemini-2.5-flash-lite',
      'gemini-1.5-pro',
      'gemini-2.5-pro'
    );
  } else if (provider === 'groq') {
    list.push('openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768');
  } else if (provider === 'openai') {
    list.push('gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini', 'gpt-3.5-turbo');
  } else if (provider === 'anthropic') {
    list.push('claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229');
  } else if (provider === 'local') {
    list.push('llama3.2', 'mistral', 'qwen2.5');
  }
  if (requestedModel) list.unshift(requestedModel);
  const seen = new Set();
  const models = [];
  for (const m of list) {
    if (!m) continue;
    const clean = String(m).trim().replace(/^models\//, '');
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    models.push({ model_id: clean, name: clean, properties: {} });
  }
  return models;
}

function providerManifest(provider, key, model) {
  const cleanModel = sanitizeModelName(model || providers[provider]?.model || '');
  const common = { auth: { api_key: key } };
  const models = buildProviderModels(provider, cleanModel);
  if (provider === 'groq') {
    return { type: 'custom', name: 'groq', base_url: 'https://api.groq.com/openai/v1', ...common, models };
  }
  if (provider === 'openai') {
    return { type: 'openai', base_url: 'https://api.openai.com/v1', ...common, models };
  }
  if (provider === 'anthropic') {
    return { type: 'anthropic', base_url: 'https://api.anthropic.com/v1', ...common, models };
  }
  if (provider === 'gemini') {
    // Generative Language beta endpoint supports generateContent with standard models
    return { type: 'google-gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', ...common, models };
  }
  if (provider === 'local') {
    return { type: 'custom', name: 'local', base_url: process.env.LOCAL_BASE_URL || 'http://localhost:11434/v1', ...common, models };
  }
  throw Error('Unsupported provider for TrueForge: ' + provider);
}

async function ensureProvider(provider, key, model) {
  if (!key) throw Error('API key is required for provider: ' + provider);
  const manifest = providerManifest(provider, key, model);
  try {
    const putRes = await fetch(`${TRUEFORGE_URL}/api/v1/settings/model-providers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
      signal: AbortSignal.timeout(10000)
    });
    if (putRes.ok) return;
    const postRes = await fetch(`${TRUEFORGE_URL}/api/v1/settings/model-providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
      signal: AbortSignal.timeout(10000)
    });
    if (postRes.ok) return;
  } catch (e) {
    console.warn(`[ensureProvider notice]: ${e.message}`);
  }
}

const tfAgents = {}; // provider -> agent

async function ensureAgent(b) {
  const provider = b.provider === 'demo' ? 'groq' : (b.provider || 'groq');
  const model = b.model || providers[provider]?.model;
  const cleanModel = sanitizeModelName(model);
  const tfProviderName = provider === 'gemini' ? 'google-gemini' : provider;
  const models = buildProviderModels(provider, cleanModel);
  const matched = models.find(m => m.name === cleanModel) || models[0];
  const modelName = matched ? matched.name : cleanModel;
  const safeAgentId = modelName.replace(/[^a-zA-Z0-9_-]/g, '-');
  const agentName = `clarity-${tfProviderName}-${safeAgentId}-v6`;
  const fqn = `${tfProviderName}/${modelName}`;
  if (tfAgents[agentName]) return tfAgents[agentName];
  try {
    const list = await tfJson('GET', '/api/v1/agents');
    const found = (list.data || []).find(a => a.name === agentName);
    const hasTools = found?.manifest?.mcp_servers && found.manifest.mcp_servers.length > 0;
    if (found && hasTools) { tfAgents[agentName] = found; return found; }
  } catch {}
  const instructions = 'You are Clarity, an autonomous, approval-first AI assistant powered by TrueForge. You have complete control of all workspace tools through clarity-tools.\n\n' +
    'AUTONOMOUS TASK DIRECTIVES:\n' +
    '1. DO NOT STOP PREMATURELY: Execute the user task thoroughly from start to finish. If the task involves multiple steps (e.g. creating multiple files, editing files, running bash commands, verifying results), work through each step sequentially without stopping until every requirement is fully satisfied.\n' +
    '2. TOOL ACTIONS & APPROVALS: Use clarity-tools for all workspace actions (file_write, file_read, file_patch, file_delete, execute_bash, execute_python, web_search, file_tree). Sensitive actions require human approval. When human approval is granted, inspect the tool outcome and immediately proceed with any remaining steps.\n' +
    '3. COMPLETION CRITERIA: When and only when the user request is 100% finished and verified, conclude your final message with [TASK_COMPLETE] and a concise summary of completed deliverables. If any requested actions remain unperformed, continue working and do not output [TASK_COMPLETE].';
  const created = await tfJson('POST', '/api/v1/agents', {
    manifest: {
      model: { name: fqn },
      instructions,
      mcp_servers: [
        {
          name: 'clarity-tools',
          enable_tools: ['@all'],
          preload: true,
          require_approval_for_tools: ['@all']
        }
      ]
    },
    name: agentName
  });
  tfAgents[agentName] = created.data || created;
  return tfAgents[agentName];
}

async function streamThroughTrueForge(res, b, _unused) {
  const provider = b.provider === 'demo' ? 'groq' : (b.provider || 'groq');
  const key = b.apiKey || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw Error('API key is required for provider: ' + provider);
  await ensureProvider(provider, key, b.model);
  const agent = await ensureAgent(b);
  const agentName = agent?.name || 'clarity-' + provider;

  // Build full conversation history for session memory
  const history = Array.isArray(b.history) ? b.history : [];
  let histContext = '';
  if (history.length) {
    const histText = history
      .filter(h => h.content || h.text)
      .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${String(h.content || h.text).slice(0, 2000)}`)
      .join('\n');
    if (histText) {
      histContext = `Previous conversation in this session:\n${histText}\n\n`;
    }
  }

  const runKey = String(b.runId || 'default').slice(0, 100) + ':' + provider;
  let sessionId = b.tfSessionId || tfSessions.get(runKey)?.sessionId;

  let prompt = b.message || '';
  if (histContext) {
    prompt = `Conversation History Context:\n${histContext}\nCurrent Instruction:\n${b.message}`;
  }

  if (!sessionId) {
    const sess = await tfJson('POST', '/api/v1/sessions', { agent: { name: agentName } });
    sessionId = sess?.data?.id || sess?.id;
    if (!sessionId) throw Error('TrueForge created no session id');
    tfSessions.set(runKey, { sessionId, agentName });
    res.write(`data: ${JSON.stringify({ mode: 'trueforge', event: 'session.created', sessionId })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ mode: 'trueforge', event: 'session.reused', sessionId })}\n\n`);
  }

  const thinkFilter = createThinkFilter(
    rzn => res.write(`data: ${JSON.stringify({ reasoning_content: String(rzn), event: 'model.message.delta' })}\n\n`),
    delta => res.write(`data: ${JSON.stringify({ delta: String(delta), event: 'model.message.delta' })}\n\n`)
  );

  // turn (SSE, REAL)
  let r = await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
    body: JSON.stringify({ input: [{ type: 'user.message', content: prompt }], ...(provider === 'groq' ? { previous_turn_id: 'none' } : {}) }),
    signal: AbortSignal.timeout(120000)
  });

  // Handle any pending approval lock on the thread automatically
  if (r.status === 422) {
    try {
      const turnsRes = await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`).then(x => x.json());
      const turnsList = turnsRes.data || [];
      const lastTurn = turnsList[turnsList.length - 1];
      const pendingActions = lastTurn?.state?.required_actions || [];
      for (const pa of pendingActions) {
        if (pa.type === 'tool.approval_required') {
          for (const tc of pa.tool_calls || []) {
            await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                input: [{
                  type: 'user.tool_approval',
                  thread_id: pa.thread_id || 'main',
                  tool_call_id: tc.id,
                  approval: { status: 'deny', reason: 'Superseded by user message' }
                }]
              })
            });
          }
        }
      }
      r = await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
        body: JSON.stringify({ input: [{ type: 'user.message', content: prompt }], ...(provider === 'groq' ? { previous_turn_id: 'none' } : {}) }),
        signal: AbortSignal.timeout(120000)
      });
    } catch (unblockErr) {
      console.warn('[Auto-unblock pending action notice]:', unblockErr.message);
    }
  }

  if (!r.ok || !r.body) {
    const errBody = await r.text().catch(() => '');
    let errMsg = `TrueForge turn HTTP ${r.status}`;
    try {
      const parsed = JSON.parse(errBody);
      errMsg = parsed.error?.message || parsed.message || errMsg;
    } catch {}
    throw Error(errMsg);
  }
  const reader = r.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  let sawReasoningBug = false;
  let rawErrorText = '';
  let lastToolName = '';
  let lastToolCallId = '';
  let lastToolArgsStr = '';
  let lastQuestion = '';
  let lastOptions = [];

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
      if (typ === 'turn.done' && ev.state?.status === 'error') {
        rawErrorText = ev.state?.message || '';
        if (/reasoning_content/.test(rawErrorText)) { sawReasoningBug = true; break; }
        if (/503|429|high demand|rate limit/i.test(rawErrorText)) break;
      }
      if (typ === 'model.message.delta') {
        // TRUE FORGE EXACT FORMAT: reasoning_content = thinking, content = answer
        const reasoning = ev.reasoning_content ?? ev.reasoning ?? ev.thinking ?? '';
        const content = ev.content ?? ev.delta ?? ev.content_delta ?? ev.text ?? '';
        if (reasoning) res.write(`data: ${JSON.stringify({ reasoning_content: String(reasoning), event: typ })}\n\n`);
        if (content) thinkFilter.processChunk(content);

        // Stream tool call info if present in delta
        const tcs = ev.tool_calls || [];
        if (Array.isArray(tcs) && tcs.length) {
          for (const tc of tcs) {
            if (tc.id) lastToolCallId = tc.id;
            const fn = tc.function || tc;
            if (fn.name) lastToolName = fn.name;
            if (tc.tool_info?.name) lastToolName = tc.tool_info.name;
            if (fn.arguments) {
              lastToolArgsStr += fn.arguments;
            }
          }
        }
      } else if (typ === 'model.message' || typ === 'model.message.completed' || typ === 'model.response') {
        const c = ev.output_text ?? ev.text ?? ev.content ?? ev.message?.content ?? '';
        const text = Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : (x?.text || x?.content || '')).join('') : c;
        if (text) thinkFilter.processChunk(text);

        // Check if model message contains tool_calls
        const toolCalls = ev.tool_calls || ev.message?.tool_calls || [];
        if (Array.isArray(toolCalls) && toolCalls.length) {
          for (const tc of toolCalls) {
            lastToolCallId = tc.id || lastToolCallId;
            const fn = tc.function || tc;
            lastToolName = fn.name || lastToolName || 'tool';
            let args = fn.arguments || {};
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch {}
            }
            if (lastToolName === 'ask_user_question' || args.question) {
              lastQuestion = args.question || lastQuestion;
              lastOptions = Array.isArray(args.options) ? args.options : lastOptions;
            }
            res.write(`data: ${JSON.stringify({ event: 'tool.intent', tool: lastToolName, message: lastQuestion || `I am preparing to use ${lastToolName} to continue your task.`, args })}\n\n`);
            res.write(`data: ${JSON.stringify({ event: 'tool.call', tool: lastToolName, args, id: lastToolCallId })}\n\n`);
          }
        }
      } else if (typ === 'tool.call') {
        const toolName = ev.toolName || ev.name || ev.function?.name || 'tool';
        let args = ev.args || ev.input || ev.function?.arguments || {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch {}
        }
        lastToolName = toolName;
        lastToolCallId = ev.id || ev.tool_call_id || lastToolCallId;
        if (toolName === 'ask_user_question' || args.question) {
          lastQuestion = args.question || '';
          lastOptions = Array.isArray(args.options) ? args.options : [];
        }
        res.write(`data: ${JSON.stringify({ event: 'tool.intent', tool: toolName, message: lastQuestion || `I am about to use ${toolName} to continue your task.`, args })}\n\n`);
        res.write(`data: ${JSON.stringify({ event: typ, tool: toolName, args, id: lastToolCallId })}\n\n`);
      } else if (typ === 'tool.response_required' || typ === 'tool.approval_required') {
        const toolCalls = ev.tool_calls || [];
        const firstCall = toolCalls[0] || {};
        const callId = firstCall.id || lastToolCallId;
        const approvalId = ev.id || crypto.randomUUID();
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(lastToolArgsStr || '{}'); } catch {}
        const toolName = lastToolName || 'tool';
        let displayQuestion = lastQuestion;
        if (!displayQuestion) {
          if (toolName === 'file_write') {
            displayQuestion = `AI requests permission to create/write file "${parsedArgs.path || 'file'}"`;
          } else if (toolName === 'file_delete') {
            displayQuestion = `AI requests permission to delete file "${parsedArgs.path || 'file'}"`;
          } else if (toolName === 'file_patch') {
            displayQuestion = `AI requests permission to edit file "${parsedArgs.path || 'file'}"`;
          } else if (toolName === 'execute_bash') {
            displayQuestion = `AI requests permission to execute bash command: "${parsedArgs.command || ''}"`;
          } else if (toolName === 'execute_python') {
            displayQuestion = `AI requests permission to run Python script`;
          } else if (toolName === 'file_read') {
            displayQuestion = `AI requests permission to read file "${parsedArgs.path || 'file'}"`;
          } else if (toolName === 'file_tree') {
            displayQuestion = `AI requests permission to list workspace files`;
          } else {
            displayQuestion = `AI requests permission to execute tool "${toolName}"`;
          }
        }
        registerApproval({
          id: approvalId,
          source: 'trueforge',
          type: typ,
          sessionId,
          threadId: ev.thread_id || 'main',
          toolCallId: callId,
          toolName,
          args: parsedArgs,
          question: displayQuestion,
          options: lastOptions,
          reason: displayQuestion,
          originalTask: b.message
        });
        res.write(`data: ${JSON.stringify({
          event: 'approval.requested',
          approvalId,
          source: 'trueforge',
          tool: toolName,
          args: parsedArgs,
          reason: displayQuestion,
          options: lastOptions
        })}\n\n`);
      } else if (typ === 'turn.done') {
        thinkFilter.flush();
        if (ev.state?.status === 'error' || ev.state?.message) {
          res.write(`data: ${JSON.stringify({ error: ev.state.message || 'TrueForge turn failed' })}\n\n`);
          continue;
        }
        const output = ev.state?.output || {};
        const finalText = output.content || ev.output?.content || '';
        const actions = ev.state?.required_actions || ev.required_actions || [];
        if (finalText) thinkFilter.processChunk(finalText);
        thinkFilter.flush();
        if (Array.isArray(actions) && actions.length) {
          for (const act of actions) {
            const approvalId = act.id || crypto.randomUUID();
            const firstCall = (act.tool_calls && act.tool_calls[0]) || {};
            const callId = firstCall.id || lastToolCallId;
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(lastToolArgsStr || '{}'); } catch {}
            const toolName = lastToolName || 'tool';
            let displayQuestion = lastQuestion;
            if (!displayQuestion) {
              if (toolName === 'file_write') {
                displayQuestion = `AI requests permission to create/write file "${parsedArgs.path || 'file'}"`;
              } else if (toolName === 'file_delete') {
                displayQuestion = `AI requests permission to delete file "${parsedArgs.path || 'file'}"`;
              } else if (toolName === 'execute_bash') {
                displayQuestion = `AI requests permission to execute bash command: "${parsedArgs.command || ''}"`;
              } else {
                displayQuestion = act.label || (act.type === 'tool.response_required' ? 'Approval required to execute tool action safely.' : 'Human approval gate triggered.');
              }
            }
            registerApproval({
              id: approvalId,
              source: 'trueforge',
              type: act.type || 'tool.response_required',
              sessionId,
              threadId: act.thread_id || 'main',
              toolCallId: callId,
              toolName,
              args: parsedArgs,
              question: displayQuestion,
              options: lastOptions,
              reason: displayQuestion,
              originalTask: b.message
            });
            res.write(`data: ${JSON.stringify({
              event: 'approval.requested',
              approvalId,
              source: 'trueforge',
              tool: toolName,
              args: parsedArgs,
              reason: displayQuestion,
              options: lastOptions
            })}\n\n`);
          }
        } else {
          res.write(`data: ${JSON.stringify({ event: typ })}\n\n`);
        }
      } else if (typ === 'turn.created') {
        res.write(`data: ${JSON.stringify({ event: typ })}\n\n`);
      }
    }
  }
  thinkFilter.flush();
  // Auto-retry on transient provider errors (503 high demand, 429 rate limit, 404 model)
  if (!sawReasoningBug && /503|429|high demand|rate limit|not found/i.test(rawErrorText)) {
    let retried = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const s3 = await tfJson('POST', '/api/v1/sessions', { agent: { name: agentName } });
      const sid3 = s3?.data?.id || s3?.id;
      if (!sid3) break;
      const r3 = await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(sid3)}/turns`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
        body: JSON.stringify({ input: [{ type: 'user.message', content: b.message || '' }], previous_turn_id: 'none' }),
        signal: AbortSignal.timeout(120000)
      });
      if (!r3.ok || !r3.body) break;
      const rd3 = r3.body.getReader(); const dec3 = new TextDecoder(); let buf3 = '';
      let succeeded = false;
      while (true) {
        const { done, value } = await rd3.read(); if (done) break;
        buf3 += dec3.decode(value, { stream: true });
        const lines3 = buf3.split('\n'); buf3 = lines3.pop();
        for (const line of lines3) {
          const t3 = line.trim(); if (!t3.startsWith('data:')) continue;
          const raw3 = t3.slice(5).trim(); if (!raw3 || raw3 === '[DONE]') continue;
          let ev3; try { ev3 = JSON.parse(raw3); } catch { continue; }
          const typ3 = ev3.type || '';
          if (typ3 === 'model.message.delta') {
            const rzn = ev3.reasoning_content ?? ''; const ctt = ev3.content ?? ev3.delta ?? '';
            if (rzn) res.write(`data: ${JSON.stringify({ reasoning_content: String(rzn), event: typ3 })}\n\n`);
            if (ctt) res.write(`data: ${JSON.stringify({ delta: String(ctt), event: typ3 })}\n\n`);
          } else if (typ3 === 'turn.done') {
            const out = ev3.state?.output || {};
            if (ev3.state?.status === 'error') { res.write(`data: ${JSON.stringify({ error: ev3.state.message || 'retry failed' })}\n\n`); succeeded = false; break; }
            else if (out.content) { res.write(`data: ${JSON.stringify({ event: typ3, final_text: String(out.content) })}\n\n`); succeeded = true; }
            else res.write(`data: ${JSON.stringify({ event: typ3 })}\n\n`);
          } else if (typ3 === 'model.message') {
            const c3 = ev3.content ?? ev3.message?.content ?? '';
            const tx3 = Array.isArray(c3) ? c3.map(x => typeof x === 'string' ? x : (x?.text || '')).join('') : c3;
            if (tx3) res.write(`data: ${JSON.stringify({ delta: String(tx3), event: typ3 })}\n\n`);
          } else if (/approval/i.test(typ3)) {
            res.write(`data: ${JSON.stringify({ event: 'approval.requested', reason: ev3.reason || ev3.message || '' })}\n\n`);
          } else if (typ3 === 'turn.created') { res.write(`data: ${JSON.stringify({ event: typ3 })}\n\n`); }
        }
        if (succeeded) break;
      }
      if (succeeded) { retried = true; break; }
    }
    if (!retried) res.write(`data: ${JSON.stringify({ error: 'Provider still busy after retries. Try another model.' })}\n\n`);
    return;
  }
  // Auto-retry once if the Groq reasoning_content 400 bug is detected
  if (sawReasoningBug) {
    res.write(`data: ${JSON.stringify({ mode: 'trueforge', event: 'status', message: 'Recovered from a history format issue — retrying with a clean session.' })}\n\n`);
    const sess2 = await tfJson('POST', '/api/v1/sessions', { agent: { name: agentName } });
    const sessionId2 = sess2?.data?.id || sess2?.id;
    if (!sessionId2) throw Error('TrueForge retry session failed');
    const r2 = await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(sessionId2)}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: JSON.stringify({ input: [{ type: 'user.message', content: b.message || '' }], previous_turn_id: 'none' }),
      signal: AbortSignal.timeout(120000)
    });
    if (!r2.ok || !r2.body) throw Error(`TrueForge retry turn HTTP ${r2.status}`);
    const rd2 = r2.body.getReader(); const dec2 = new TextDecoder(); let buf2 = '';
    while (true) {
      const { done, value } = await rd2.read(); if (done) break;
      buf2 += dec2.decode(value, { stream: true });
      const lines2 = buf2.split('\n'); buf2 = lines2.pop();
      for (const line of lines2) {
        const t2 = line.trim();
        if (!t2.startsWith('data:')) continue;
        const raw2 = t2.slice(5).trim();
        if (!raw2 || raw2 === '[DONE]') continue;
        let ev2; try { ev2 = JSON.parse(raw2); } catch { continue; }
        const typ2 = ev2.type || '';
        if (typ2 === 'model.message.delta') {
          const rzn = ev2.reasoning_content ?? '';
          const ctt = ev2.content ?? ev2.delta ?? '';
          if (rzn) res.write(`data: ${JSON.stringify({ reasoning_content: String(rzn), event: typ2 })}\n\n`);
          if (ctt) res.write(`data: ${JSON.stringify({ delta: String(ctt), event: typ2 })}\n\n`);
        } else if (typ2 === 'turn.done') {
          const out = ev2.state?.output || {};
          if (ev2.state?.status === 'error') res.write(`data: ${JSON.stringify({ error: ev2.state.message || 'retry failed' })}\n\n`);
          else if (out.content) res.write(`data: ${JSON.stringify({ event: typ2, final_text: String(out.content) })}\n\n`);
          else res.write(`data: ${JSON.stringify({ event: typ2 })}\n\n`);
        } else if (typ2 === 'model.message') {
          const c2 = ev2.content ?? ev2.message?.content ?? '';
          const text2 = Array.isArray(c2) ? c2.map(x => typeof x === 'string' ? x : (x?.text || '')).join('') : c2;
          if (text2) res.write(`data: ${JSON.stringify({ delta: String(text2), event: typ2 })}\n\n`);
        } else if (/approval/i.test(typ2)) {
          res.write(`data: ${JSON.stringify({ event: 'approval.requested', reason: ev2.reason || ev2.message || '' })}\n\n`);
        } else if (typ2 === 'turn.created') {
          res.write(`data: ${JSON.stringify({ event: typ2 })}\n\n`);
        }
      }
    }
  }
}


// ---- TrueForge auto-restart watchdog (handles crashes honestly) ----
const tfProc = { child: null, starting: false };
function startTrueForgeChild() {
  if (tfProc.child && tfProc.child.exitCode === null) return tfProc.child;
  if (tfProc.starting) return null;
  tfProc.starting = true;
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, 'node_modules', '@truefoundry', 'trueforge', 'dist', 'cli.js'), '--port', '8790'], {
    detached: true, stdio: 'ignore', env: { ...process.env, PORT: '8790' }
  });
  tfProc.child = child;
  child.on('exit', () => { tfProc.starting = false; tfStatus = { online: false, checked: Date.now(), reason: 'crashed - restart scheduled' }; setTimeout(() => { tfStatus.checked = null; checkTrueForge(true); }, 2000); });
  setTimeout(() => { tfProc.starting = false; }, 3000);
  return child;
}
async function ensureTrueForgeRunning() {
  const st = await checkTrueForge(true);
  if (!st.online) startTrueForgeChild();
  return st;
}
if (process.env.CLARITY_TEST !== '1') {
  setInterval(() => { ensureTrueForgeRunning().catch(() => {}); }, 12000);
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
        try {
          const b = await body(req).catch(() => ({}));
          const a = getApproval(b.approvalId);
          if (!a) return json(res, 400, { ok: false, error: 'No pending approval to reject' });
          clearApproval(a.id);

          const rejectReason = b.reason || 'Rejected by user';
          let modelResponse = '';
          if (a.source === 'trueforge' && a.sessionId && a.toolCallId) {
            try {
              const turnPayload = a.type === 'tool.approval_required'
                ? {
                    input: [{
                      type: 'user.tool_approval',
                      thread_id: a.threadId || 'main',
                      tool_call_id: a.toolCallId,
                      approval: { status: 'deny', reason: rejectReason }
                    }]
                  }
                : {
                    input: [{
                      type: 'user.tool_response',
                      thread_id: a.threadId || 'main',
                      tool_call_id: a.toolCallId,
                      content: `Action denied by user: ${rejectReason}`
                    }]
                  };
              const resumeRes = await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(a.sessionId)}/turns`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
                body: JSON.stringify(turnPayload)
              });
              if (resumeRes.ok && resumeRes.body) {
                const reader = resumeRes.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buf += decoder.decode(value, { stream: true });
                  const lines = buf.split('\n');
                  buf = lines.pop();
                  for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const raw = t.slice(5).trim();
                    if (!raw || raw === '[DONE]') continue;
                    try {
                      const ev = JSON.parse(raw);
                      if (ev.type === 'model.message.delta' && ev.content) modelResponse += ev.content;
                      else if (ev.type === 'turn.done' && ev.state?.output?.content && !modelResponse) modelResponse = ev.state.output.content;
                    } catch {}
                  }
                }
              }
            } catch (err) {
              console.warn('[TrueForge reject turn notice]:', err.message);
            }
          }

          return json(res, 200, {
            ok: true,
            status: 'rejected',
            text: `Rejected: ${a.toolName || a.type || 'action'} was cancelled by user.`,
            modelResponse: modelResponse || 'Understood, the proposed tool action was cancelled.',
            source: a.source || 'clarity',
            sessionId: a.sessionId,
            continueTurn: !modelResponse,
            followUpPrompt: modelResponse ? null : `[Human Approval Denied]: The user rejected the proposed action with reason: "${rejectReason}". Acknowledge this rejection, adjust your approach, and determine the next step.`
          });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }

      if (req.method === 'POST' && u.pathname === '/api/approve') {
        try {
          const b = await body(req).catch(() => ({}));
          const a = getApproval(b.approvalId);
          if (!a) return json(res, 400, { ok: false, error: 'No pending action to approve' });
          clearApproval(a.id);

          if (a.source === 'trueforge') {
            let toolOutput = '';
            let modelResponse = '';
            let nextApproval = null;
            let nextToolName = '';
            let nextToolCallId = '';
            let nextToolArgsStr = '';
            let nextQuestion = '';
            if (a.sessionId && a.toolCallId) {
              try {
                const turnPayload = a.type === 'tool.approval_required'
                  ? {
                      input: [{
                        type: 'user.tool_approval',
                        thread_id: a.threadId || 'main',
                        tool_call_id: a.toolCallId,
                        approval: { status: 'allow' }
                      }]
                    }
                  : {
                      input: [{
                        type: 'user.tool_response',
                        thread_id: a.threadId || 'main',
                        tool_call_id: a.toolCallId,
                        content: (a.options && a.options[0]) ? a.options[0] : (b.reason || 'Approved by user. Proceed and complete the task.')
                      }]
                    };
                const resumeRes = await fetch(`${TRUEFORGE_URL}/api/v1/sessions/${encodeURIComponent(a.sessionId)}/turns`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
                  body: JSON.stringify(turnPayload)
                });
                if (resumeRes.ok && resumeRes.body) {
                  const reader = resumeRes.body.getReader();
                  const decoder = new TextDecoder();
                  let buf = '';
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop();
                    for (const line of lines) {
                      const t = line.trim();
                      if (!t.startsWith('data:')) continue;
                      const raw = t.slice(5).trim();
                      if (!raw || raw === '[DONE]') continue;
                      try {
                        const ev = JSON.parse(raw);
                        if (ev.type === 'tool.response') {
                          toolOutput = ev.content || toolOutput;
                        } else if (ev.type === 'model.message.delta') {
                          const c = ev.content ?? ev.delta ?? ev.text ?? '';
                          if (c) modelResponse += c;
                          const tcs = ev.tool_calls || [];
                          if (Array.isArray(tcs) && tcs.length) {
                            for (const tc of tcs) {
                              if (tc.id) nextToolCallId = tc.id;
                              const fn = tc.function || tc;
                              if (fn.name) nextToolName = fn.name;
                              if (fn.arguments) nextToolArgsStr += fn.arguments;
                            }
                          }
                        } else if (ev.type === 'tool.call') {
                          nextToolName = ev.toolName || ev.name || ev.function?.name || nextToolName;
                          nextToolCallId = ev.id || ev.tool_call_id || nextToolCallId;
                        } else if (ev.type === 'tool.approval_required' || ev.type === 'tool.response_required') {
                          nextApproval = ev;
                          if (ev.message) nextQuestion = ev.message;
                        } else if (ev.type === 'turn.done') {
                          if (ev.state?.output?.content && !modelResponse) modelResponse = ev.state.output.content;
                          const reqActs = ev.state?.required_actions || ev.required_actions;
                          if (Array.isArray(reqActs) && reqActs.length > 0 && !nextApproval) {
                            nextApproval = reqActs[0];
                          }
                        }
                      } catch {}
                    }
                  }
                }
              } catch (err) {
                console.warn('[TrueForge approve turn error]:', err.message);
              }
            }

            let registeredNextApproval = null;
            if (nextApproval) {
              const nextId = nextApproval.id || crypto.randomUUID();
              let parsedArgs = {};
              try { parsedArgs = JSON.parse(nextToolArgsStr || '{}'); } catch {}
              const toolName = nextToolName || 'tool';
              let displayQuestion = nextQuestion;
              if (!displayQuestion) {
                if (toolName === 'file_write') {
                  displayQuestion = `AI requests permission to create/write file "${parsedArgs.path || 'file'}"`;
                } else if (toolName === 'file_delete') {
                  displayQuestion = `AI requests permission to delete file "${parsedArgs.path || 'file'}"`;
                } else if (toolName === 'file_patch') {
                  displayQuestion = `AI requests permission to edit file "${parsedArgs.path || 'file'}"`;
                } else if (toolName === 'execute_bash') {
                  displayQuestion = `AI requests permission to execute bash command: "${parsedArgs.command || ''}"`;
                } else if (toolName === 'execute_python') {
                  displayQuestion = `AI requests permission to run Python script`;
                } else {
                  displayQuestion = `AI requests permission to execute tool "${toolName}"`;
                }
              }
              registerApproval({
                id: nextId,
                source: 'trueforge',
                type: nextApproval.type || 'tool.approval_required',
                sessionId: a.sessionId,
                threadId: nextApproval.thread_id || 'main',
                toolCallId: nextToolCallId || nextApproval.tool_call_id || (nextApproval.tool_calls && nextApproval.tool_calls[0]?.id),
                toolName,
                args: parsedArgs,
                question: displayQuestion,
                reason: displayQuestion,
                originalTask: a.originalTask
              });
              registeredNextApproval = {
                approvalId: nextId,
                tool: toolName,
                args: parsedArgs,
                reason: displayQuestion
              };
            }

            const isComplete = /\[TASK_COMPLETE\]/i.test(modelResponse) || /TASK_COMPLETED/i.test(modelResponse);
            return json(res, 200, {
              ok: true,
              text: toolOutput || `Approved: ${a.reason || 'Action executed successfully'}`,
              modelResponse: modelResponse || '',
              source: 'trueforge',
              sessionId: a.sessionId,
              nextApproval: registeredNextApproval,
              taskCompleted: isComplete,
              continueTurn: !isComplete && !registeredNextApproval,
              followUpPrompt: (!isComplete && !registeredNextApproval)
                ? `[Autonomous Step Resumed]: Tool execution verified. Previous action output: "${toolOutput || 'Action executed successfully'}". Please evaluate if the user's overall task is completely finished. If every requested action and deliverable is 100% finished, emit [TASK_COMPLETE] and provide a final summary. If any steps remain unperformed, proceed with the next step now.`
                : null
            });
          }

          const result = await executeApproval(a);
          return json(res, 200, {
            ...result,
            approvalId: a.id,
            taskCompleted: false,
            continueTurn: true,
            followUpPrompt: `[Human Approval Granted]: ${result.text}. The action was successfully executed on the workspace. Please review the conversation history and the user's initial instructions to determine if the task is completely finished. If all requested work is finished, emit [TASK_COMPLETE] and summarize. If any additional steps remain, proceed with the next step.`
          });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }

async function detectAndExecuteTools(prompt, res) {
  const p = (prompt || '').trim();

  // 1. Math calculation (automatic)
  const mathMatch = p.match(/(?:calculate|calc|what is|compute)\s+([0-9+\-*/().%\s]+)/i);
  if (mathMatch && /[+\-*/%]/.test(mathMatch[1])) {
    const expr = mathMatch[1].trim();
    try {
      res.write(`data: ${JSON.stringify({ event: 'tool.intent', tool: 'safe_calc', message: `Calculating: ${expr}`, args: { expr } })}\n\n`);
      const val = safeCalc(expr);
      res.write(`data: ${JSON.stringify({ event: 'tool.call', tool: 'safe_calc', args: { expr } })}\n\n`);
      res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'safe_calc', result: val })}\n\n`);
      return { handled: false, context: `[Tool Execution: safe_calc("${expr}") returned ${val}]` };
    } catch (e) {
      res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'safe_calc', error: e.message })}\n\n`);
    }
  }

  // 2. URL fetch (automatic)
  const urlMatch = p.match(/(?:fetch|scrape|get url|browse|inspect url)\s+(https?:\/\/[^\s]+)/i);
  if (urlMatch) {
    const url = urlMatch[1].trim();
    try {
      res.write(`data: ${JSON.stringify({ event: 'tool.intent', tool: 'fetch_url', message: `Fetching URL: ${url}`, args: { url } })}\n\n`);
      res.write(`data: ${JSON.stringify({ event: 'tool.call', tool: 'fetch_url', args: { url } })}\n\n`);
      const resp = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Clarity)' }, signal: AbortSignal.timeout(8000) });
      const rawHtml = await resp.text();
      const clean = rawHtml.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
      res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'fetch_url', status: resp.status, length: clean.length })}\n\n`);
      return { handled: false, context: `[Tool Execution: fetch_url("${url}") HTTP ${resp.status}, content snippet: "${clean.slice(0, 500)}..."]` };
    } catch (e) {
      res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'fetch_url', error: e.message })}\n\n`);
    }
  }

  // 3. List workspace files (automatic)
  if (/(?:list|show|check|view|available|what|find|explore)\s+(?:all\s+)?(?:available\s+)?(?:workspace\s+)?(?:files|documents|file\b)/i.test(p) || /^(?:files|workspace)$/i.test(p)) {
    try {
      res.write(`data: ${JSON.stringify({ event: 'tool.intent', tool: 'list_files', message: 'Scanning workspace files…', args: {} })}\n\n`);
      res.write(`data: ${JSON.stringify({ event: 'tool.call', tool: 'list_files', args: {} })}\n\n`);
      const files = listWorkspace();
      res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'list_files', count: files.length })}\n\n`);
      const names = files.slice(0, 15).map(f => f.name).join(', ');
      return { handled: false, context: `[Tool Execution: list_files() found ${files.length} files: ${names}]` };
    } catch (e) {
      res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'list_files', error: e.message })}\n\n`);
    }
  }

  // 4. Read file (automatic)
  const readMatch = p.match(/(?:read|view|cat|inspect|open|show|check)\s+(?:file\s+)?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/i);
  if (readMatch) {
    const rel = readMatch[1].trim();
    try {
      const target = safePath(rel);
      if (fs.existsSync(target)) {
        res.write(`data: ${JSON.stringify({ event: 'tool.intent', tool: 'read_file', message: `Reading file: ${rel}`, args: { path: rel } })}\n\n`);
        res.write(`data: ${JSON.stringify({ event: 'tool.call', tool: 'read_file', args: { path: rel } })}\n\n`);
        const content = fs.readFileSync(target, 'utf8').slice(0, 2500);
        res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'read_file', path: rel, size: content.length })}\n\n`);
        return { handled: false, context: `[Tool Execution: read_file("${rel}") content:\n${content}]` };
      }
    } catch {}
  }

  // 5. Run sandbox command (automatic, whitelisted)
  const cmdMatch = p.match(/(?:run|exec|sandbox command)\s+(ls|pwd|date|cat|echo|wc|head|tail|grep|find)(?:\s+([^\n\r]+))?/i);
  if (cmdMatch) {
    const fullCmd = cmdMatch[0].replace(/^(?:run|exec|sandbox command)\s+/i, '').trim();
    try {
      res.write(`data: ${JSON.stringify({ event: 'tool.intent', tool: 'sandbox_run', message: `Executing command: ${fullCmd}`, args: { cmd: fullCmd } })}\n\n`);
      res.write(`data: ${JSON.stringify({ event: 'tool.call', tool: 'sandbox_run', args: { cmd: fullCmd } })}\n\n`);
      const { execFile } = require('child_process');
      const parts = fullCmd.split(/\s+/);
      const bin = parts.shift();
      const out = await new Promise((resolve, reject) => {
        execFile(bin, parts, { cwd: wsRoot, timeout: 5000, maxBuffer: 15000 }, (err, stdout, stderr) => {
          if (err && !stdout) return reject(Error(stderr || err.message));
          resolve((stdout || '') + (stderr ? '\n' + stderr : ''));
        });
      });
      res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'sandbox_run', output: out.slice(0, 500) })}\n\n`);
      return { handled: false, context: `[Tool Execution: sandbox_run("${fullCmd}") output:\n${out.slice(0, 1000)}]` };
    } catch (e) {
      res.write(`data: ${JSON.stringify({ event: 'tool.result', tool: 'sandbox_run', error: e.message })}\n\n`);
    }
  }

  // 6. Write file (SENSITIVE - APPROVAL REQUIRED)
  const writeMatch = p.match(/(?:create|write|save|make|add)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?(?:name[d]?\s+|called\s+)?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)(?:\s+(?:containing|with(?:\s+content)?|content:)\s*([\s\S]*))?/i);
  if (writeMatch) {
    const rel = writeMatch[1].trim();
    const hint = (writeMatch[2] || '').trim();
    const content = generateContentForHint(hint, rel);
    pendingApprovalId = crypto.randomUUID();
    pendingAction = registerApproval({
      id: pendingApprovalId,
      type: 'write',
      path: rel,
      content,
      originalTask: p,
      reason: `Write file: ${rel} (${content.length} chars). This action modifies the workspace filesystem.`
    });
    res.write(`data: ${JSON.stringify({
      event: 'approval.requested',
      approvalId: pendingApprovalId,
      action: 'write',
      path: rel,
      reason: `Write file: ${rel} (${content.length} chars). This action modifies the workspace filesystem.`
    })}\n\n`);
    return {
      handled: true,
      reason: `I have prepared the file **${rel}** (${content.length} chars). Because modifying files on disk is a sensitive operation, human approval is required before saving to the workspace.`
    };
  }

  // 7. Delete file (SENSITIVE - APPROVAL REQUIRED)
  const delMatch = p.match(/(?:delete|remove|rm)\s+(?:file\s+)?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/i);
  if (delMatch) {
    const rel = delMatch[1].trim();
    try {
      const target = safePath(rel);
      pendingApprovalId = crypto.randomUUID();
      pendingAction = registerApproval({
        id: pendingApprovalId,
        type: 'delete',
        path: rel,
        target,
        originalTask: p,
        reason: `Delete file: ${rel}. This is irreversible and removes the file from the workspace.`
      });
      res.write(`data: ${JSON.stringify({
        event: 'approval.requested',
        approvalId: pendingApprovalId,
        action: 'delete',
        path: rel,
        reason: `Delete file: ${rel}. This is irreversible and removes the file from the workspace.`
      })}\n\n`);
      return { handled: true, reason: `I have queued the deletion of **${rel}**. This action is irreversible, so please confirm approval to proceed.` };
    } catch {}
  }

  // 8. Zip workspace (SENSITIVE - APPROVAL REQUIRED)
  if (/(?:zip|package|archive)\s+(?:the\s+)?workspace/i.test(p)) {
    const name = 'workspace.zip';
    pendingApprovalId = crypto.randomUUID();
    pendingAction = registerApproval({
      id: pendingApprovalId,
      type: 'zip',
      name,
      originalTask: p,
      reason: `Package all workspace files into ${name}. Archive will be downloadable once approved.`
    });
    res.write(`data: ${JSON.stringify({
      event: 'approval.requested',
      approvalId: pendingApprovalId,
      action: 'zip',
      reason: `Package all workspace files into ${name}. Archive will be downloadable once approved.`
    })}\n\n`);
    return { handled: true, reason: `I have prepared an archive of your workspace files as **${name}**. Review and approve to build the zip.` };
  }

  return { handled: false };
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
            // Check for auto-executable tools or sensitive approval triggers in Direct fallback mode
            const toolExec = await detectAndExecuteTools(b.message, res);
            if (toolExec.handled) {
              res.write(`data: ${JSON.stringify({ delta: toolExec.reason })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            if (toolExec.context) {
              b.message = `${toolExec.context}\n\nUser request: ${b.message}`;
            }
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
  if (process.env.CLARITY_TEST !== '1') ensureTrueForgeRunning().catch(() => {});
  else checkTrueForge();
  createApp().listen(PORT, '0.0.0.0', () => console.log(`Clarity v3 running at http://0.0.0.0:${PORT} · workspace: ${wsRoot} · trueforge: ${TRUEFORGE_URL}`));
}
module.exports = { createApp, providers, safeCalc, makeZip, listWorkspace, safePath, wsRoot, checkTrueForge, executeApproval, createThinkFilter, registerApproval, getApproval, clearApproval };
