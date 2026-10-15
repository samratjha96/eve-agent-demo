# hateable

A minimal Lovable-style demo: give it a task, watch an agent plan, delegate to subagents, call real tools, and ship a working site. Backed by **real inference** on `inference-api.nvidia.com` (default `gcp/google/gemini-4-argon`, override with `DEMO_MODEL`).

**Live:** https://eve-agent-demo.zasamrat.workers.dev

## Layout

- `engine.mjs` — shared agent loop (plan → parallel subagents → tool-call build → deliver), platform-agnostic
- `server.mjs` — local Node adapter, zero deps
- `worker.mjs` — Cloudflare Worker + `SessionDO` Durable Object (state persisted per event, SSE fanout)
- `index.html` — the UI, bundled into the worker as a Text module

## Run locally

```bash
NVIDIA_API_KEY=... node server.mjs
open http://127.0.0.1:8931
```

## Deploy

```bash
npx wrangler secret put NVIDIA_API_KEY   # once
npx wrangler deploy
```
