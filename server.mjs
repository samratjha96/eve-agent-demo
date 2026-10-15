#!/usr/bin/env node
// eve-agent-demo — local Node adapter. Same engine as the Cloudflare deployment.
//   NVIDIA_API_KEY=... node server.mjs   (or: envchain shell node server.mjs)
//   open http://127.0.0.1:8931

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChat, runPipeline, MODEL } from './engine.mjs';

const PORT = process.env.PORT || 8931;
const KEY = process.env.NVIDIA_API_KEY;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

if (!KEY) { console.error('NVIDIA_API_KEY not set — run via envchain or export it.'); process.exit(1); }
const chat = createChat(KEY, process.env.DEMO_MODEL || MODEL);

const sessions = new Map();
const sse = new Map();

function newSession(mission) {
  const s = { id: 'ses_' + Math.random().toString(36).slice(2, 8), mission, phase: 0, epoch: 0, events: [], vfs: {}, usage: 0, turns: 0, toolCalls: 0, status: 'running' };
  s.emit = ev => { s.events.push(ev); const set = sse.get(s.id); if (set) for (const res of set) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  sessions.set(s.id, s);
  return s;
}
const launch = s => runPipeline(s, { emit: s.emit, chat });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'POST' && url.pathname === '/api/run') {
    let body = ''; req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    const mission = (JSON.parse(body || '{}').mission || '').trim().slice(0, 300) || 'Launch a coffee brand';
    const s = newSession(mission);
    launch(s);
    return send(200, { id: s.id });
  }

  if (url.pathname.startsWith('/api/stream/')) {
    const s = sessions.get(url.pathname.split('/')[3]);
    if (!s) return send(404, { error: 'no such session' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    for (const ev of s.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (s.status !== 'running') { res.write(`data: ${JSON.stringify({ type: 'status', status: s.status })}\n\n`); return res.end(); }
    if (!sse.has(s.id)) sse.set(s.id, new Set());
    sse.get(s.id).add(res);
    req.on('close', () => sse.get(s.id)?.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/abort/')) {
    const s = sessions.get(url.pathname.split('/')[3]);
    if (!s) return send(404, {});
    if (s.status === 'running') { s.status = 'crashed'; s.emit({ type: 'status', status: 'crashed', phase: s.phase }); }
    return send(200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/resume/')) {
    const s = sessions.get(url.pathname.split('/')[3]);
    if (!s) return send(404, {});
    if (s.status === 'crashed' || s.status === 'error') { s.status = 'running'; s.emit({ type: 'status', status: 'resumed' }); launch(s); }
    return send(200, { ok: true });
  }

  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (req.method === 'GET' && file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile())
    return res.end(fs.readFileSync(file));
  send(404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`eve-agent-demo → http://127.0.0.1:${PORT}  (model: ${process.env.DEMO_MODEL || MODEL})`));
