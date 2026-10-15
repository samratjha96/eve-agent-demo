# eve-agent-demo

A single-file, zero-dependency demo of [Vercel's eve](https://github.com/vercel/eve) agent framework.

Give the agent a mission, watch it plan, delegate to subagents, call typed tools, and write a real website into its sandbox — then see the actual artifact render. Hit **Simulate crash** mid-run and resume from the last durable checkpoint (state persists in localStorage).

The session is simulated; the mechanics are faithful to how eve works: an agent is a directory (`instructions.md`, `tools/`, `skills/`, `subagents/`, `sandbox/`), and sessions run as durable workflows.

## Run it

Open `index.html` in a browser. No build step, no server, no deps.
