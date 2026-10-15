// eve-agent-demo — Cloudflare Worker + Durable Object adapter.
// Each agent session is a Durable Object: single-writer, addressable by id,
// state persisted to DO storage at every event so sessions survive eviction.

import INDEX_HTML from './index.html';
import { createChat, runPipeline, MODEL } from './engine.mjs';

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const { mission } = await req.json().catch(() => ({}));
      const id = 'ses_' + crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
      return stub.fetch('https://do/run', { method: 'POST', body: JSON.stringify({ id, mission: (mission || '').trim().slice(0, 300) || 'Launch a coffee brand' }) });
    }

    const m = url.pathname.match(/^\/api\/(stream|abort|resume)\/(ses_\w+)$/);
    if (m) {
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(m[2]));
      return stub.fetch(new Request(`https://do/${m[1]}`, req));
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
};

export class SessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.s = null;
    this.clients = new Set(); // WritableStreamDefaultWriter
    this.chat = createChat(env.NVIDIA_API_KEY, env.DEMO_MODEL || MODEL);
  }

  async hydrate() {
    if (this.s) return;
    this.s = await this.state.storage.get('session');
  }

  emit(ev) {
    this.s.events.push(ev);
    this.state.waitUntil(this.state.storage.put('session', this.s));
    const payload = new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const w of [...this.clients]) {
      w.write(payload).catch(() => this.clients.delete(w));
    }
  }

  launch() {
    this.state.waitUntil(runPipeline(this.s, { emit: ev => this.emit(ev), chat: this.chat }));
  }

  async fetch(req) {
    await this.hydrate();
    const url = new URL(req.url);
    const json = obj => Response.json(obj);

    if (url.pathname === '/run' && req.method === 'POST') {
      const { id, mission } = await req.json();
      this.s = { id, mission, phase: 0, epoch: 0, events: [], vfs: {}, usage: 0, turns: 0, toolCalls: 0, status: 'running' };
      await this.state.storage.put('session', this.s);
      this.launch();
      return json({ id });
    }

    if (!this.s) return json({ error: 'no such session' });

    if (url.pathname === '/stream') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const replay = this.s.events.map(ev => `data: ${JSON.stringify(ev)}\n\n`).join('');
      if (this.s.status !== 'running') {
        const tail = `data: ${JSON.stringify({ type: 'status', status: this.s.status })}\n\n`;
        writer.write(enc.encode(replay + tail)).then(() => writer.close()).catch(() => {});
      } else {
        if (replay) writer.write(enc.encode(replay)).catch(() => {});
        this.clients.add(writer);
      }
      return new Response(readable, { headers: SSE_HEADERS });
    }

    if (url.pathname === '/abort' && req.method === 'POST') {
      if (this.s.status === 'running') { this.s.status = 'crashed'; this.emit({ type: 'status', status: 'crashed', phase: this.s.phase }); }
      return json({ ok: true });
    }

    if (url.pathname === '/resume' && req.method === 'POST') {
      if (this.s.status === 'crashed' || this.s.status === 'error') { this.s.status = 'running'; this.emit({ type: 'status', status: 'resumed' }); this.launch(); }
      return json({ ok: true });
    }

    return json({ error: 'not found' });
  }
}
