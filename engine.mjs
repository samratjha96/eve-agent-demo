// Shared agent engine — used by server.mjs (local Node) and worker.mjs (Cloudflare DO).
// runPipeline() drives a session object; the host adapter supplies emit() and liveness.

export const MODEL = 'gcp/google/gemini-4-argon';
const API = 'https://inference-api.nvidia.com/v1/chat/completions';

export function createChat(apiKey, model = MODEL) {
  return async function chat(messages, { tools, toolChoice = 'auto', maxTokens = 4096, temperature = 0.7 } = {}) {
    const body = { model, messages, max_tokens: maxTokens, temperature };
    if (tools) { body.tools = tools; body.tool_choice = toolChoice; }
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(API, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`inference-api ${r.status}: ${(await r.text()).slice(0, 200)}`);
        return r.json();
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw lastErr;
  };
}

const INSTRUCTIONS = `You are a site-builder agent. Given a mission, you produce a finished, working web page. You plan first, delegate research/copy/design to subagents, then write the page into your sandbox with tools. Be concrete and opinionated. Output stays tight — plans in bullets, not essays.`;

const SKILLS = {
  'brand_discovery.md': `Extract from any mission: brand name (invent a good one if unspecified), one-line tagline, target audience, and the single strongest differentiator. Name things like a human would — short, evocative, no hyphens stacked.`,
  'web_copy.md': `Structure: hero (headline, subline, CTA label) then 3 sections. Each section: heading under 7 words, body under 40 words, optional card grid of 2-4 items [{title, detail}]. Confident plain-spoken voice. No lorem ipsum, no placeholder text, no marketing clichés like "unlock" or "elevate".`,
  'visual_design.md': `Choose: accent (one bold hex), bg (light neutral hex), ink (near-black hex). Hero uses a gradient from accent to ink. Cards on white with subtle borders. System font stack only. Sections max-width 880px centered.`,
};

const TOOLS = [
  { type: 'function', function: { name: 'write_sandbox_file', description: 'Write a file into the agent sandbox.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'finish_mission', description: 'Call when the deliverable is complete.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
];

const SUBAGENTS = {
  researcher: m => `You are the researcher subagent. Mission: "${m}". Return exactly 4 tight bullets: (1) target audience, (2) positioning angle, (3) strongest differentiator, (4) one concrete proof point or detail that makes it credible. No preamble.`,
  copywriter: m => `You are the copywriter subagent. Mission: "${m}". Invent a brand name and produce the copy plan: hero headline + subline + CTA label, then exactly 3 sections, each with a heading (under 7 words), body (under 40 words), and optionally 2-4 card items with title+detail. Confident plain-spoken voice, no clichés.`,
  designer: m => `You are the designer subagent. Mission: "${m}". Return design tokens as JSON only: {"accent": "#hex", "bg": "#light-neutral-hex", "ink": "#dark-hex", "vibe": ["word","word","word"]}. Accent must be bold, bg must be light.`,
};

// s: session object {mission, phase, epoch, vfs, usage, turns, status, subOutputs?, summary?}
// io: { emit(ev), chat }
export async function runPipeline(s, io) {
  const { emit, chat } = io;
  const epoch = ++s.epoch;
  const live = () => s.status === 'running' && s.epoch === epoch;
  const checkpoint = name => emit({ type: 'ckpt', name });
  const think = (text, file) => emit({ type: 'think', text, file });
  const say = (text, file) => emit({ type: 'say', text, file });
  const storeFile = (p, content) => { s.vfs[p] = content; emit({ type: 'vfs_write', path: p, bytes: content.length }); };
  const model = MODEL.split('/').pop();

  try {
    if (s.phase === 0) {
      emit({ type: 'skill', text: 'initializing agent — role: <b>site-builder</b>' });
      think(`mission received: "${s.mission}" — calling ${model} to plan`);
      const r = await chat([
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: `Mission: "${s.mission}"\n\nWrite your plan: exactly 4 short bullets, one line each. No preamble.` },
      ], { maxTokens: 300 });
      if (!live()) return;
      s.usage += r.usage?.total_tokens || 0;
      for (const line of r.choices[0].message.content.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 6))
        say(line.replace(/^[-*•\d.]+\s*/, ''));
      s.phase = 1; checkpoint('mission-planned');
    }
    if (!live()) return;

    if (s.phase === 1) {
      emit({ type: 'sub', text: 'spawning <b>3 subagents</b> — parallel model calls' });
      const lanes = Object.keys(SUBAGENTS);
      emit({ type: 'lanes', lanes });
      const results = await Promise.all(lanes.map(async name => {
        emit({ type: 'lane', lane: name, status: 'working…' });
        const r = await chat([
          { role: 'system', content: SKILLS['brand_discovery.md'] },
          { role: 'user', content: SUBAGENTS[name](s.mission) },
        ], { maxTokens: 900 });
        s.usage += r.usage?.total_tokens || 0;
        const out = r.choices[0].message.content.trim();
        if (live()) emit({ type: 'lane', lane: name, status: 'done', output: out.split('\n')[0].slice(0, 80) });
        return { name, out };
      }));
      if (!live()) return;
      s.subOutputs = results;
      s.phase = 2; checkpoint('subagents-merged');
    }
    if (!live()) return;

    if (s.phase === 2) {
      emit({ type: 'skill', text: 'loading copy + design playbooks into build context' });
      const ctx = s.subOutputs.map(o => `[${o.name}]\n${o.out}`).join('\n\n');
      const msgs = [
        { role: 'system', content: `${INSTRUCTIONS}\n\n--- skills/web_copy.md ---\n${SKILLS['web_copy.md']}\n\n--- skills/visual_design.md ---\n${SKILLS['visual_design.md']}` },
        { role: 'user', content: `Mission: "${s.mission}"\n\nSubagent outputs:\n${ctx}\n\nNow build the site. Requirements:\n- Call write_sandbox_file with path "index.html" containing ONE complete self-contained HTML file\n- All CSS inline in a <style> tag, system font stack, no external assets, no placeholder text\n- Use the copywriter's copy essentially verbatim — brand name, headline, subline, CTA, all three sections, and every card item it wrote\n- Use the designer's exact hex values for accent/bg/ink\n- Structure: full-bleed hero (accent→ink gradient, headline + subline + CTA button), three sections (max-width 880px, centered) with card grids where the copywriter gave cards, then a footer\n- Presentation-quality CSS: generous padding (60px+ hero, 48px+ sections), border-radius, subtle shadows, hover states on cards and the CTA\n- Target 4000+ bytes — this should look like a real landing page, not a wireframe\nThen call finish_mission.` },
      ];
      let done = false;
      for (let turn = 0; turn < 8 && live() && !done; turn++) {
        s.turns++;
        think(`build turn ${turn + 1} — waiting on model…`);
        const forceWrite = !s.vfs['index.html'] && turn === 0;
        const r = await chat(msgs, { tools: TOOLS, toolChoice: forceWrite ? { type: 'function', function: { name: 'write_sandbox_file' } } : 'auto', maxTokens: 16000 });
        if (!live()) return;
        s.usage += r.usage?.total_tokens || 0;
        const m = r.choices[0].message;
        msgs.push(m);
        const calls = m.tool_calls || [];
        if (!calls.length) {
          const html = /<html[\s\S]*<\/html>/i.exec(m.content || '')?.[0] || /```html([\s\S]*?)```/i.exec(m.content || '')?.[1];
          if (html) { storeFile('index.html', html.trim()); done = true; continue; }
          msgs.push({ role: 'user', content: 'Call write_sandbox_file with the complete page HTML now.' });
          continue;
        }
        for (const tc of calls) {
          let args = {}; try { args = JSON.parse(tc.function.arguments); } catch {}
          s.toolCalls++;
          emit({ type: 'tool', name: tc.function.name, args: tc.function.name === 'write_sandbox_file' ? { path: args.path, bytes: (args.content || '').length } : args });
          if (tc.function.name === 'write_sandbox_file' && args.path && args.content) storeFile(args.path, args.content);
          if (tc.function.name === 'finish_mission') { s.summary = args.summary || ''; done = true; }
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: 'ok' });
        }
      }
      if (!s.vfs['index.html']) throw new Error('agent finished without writing index.html');
      s.phase = 3; checkpoint('artifact-written');
    }
    if (!live()) return;

    if (s.phase === 3) {
      emit({ type: 'tool', name: 'deploy_artifact', args: { file: 'index.html', target: 'preview' } });
      let html = s.vfs['index.html'];
      for (const [p, c] of Object.entries(s.vfs)) {
        if (p === 'index.html') continue;
        html = html.replace(new RegExp(`<link[^>]*href=["']${p}["'][^>]*>`), `<style>${c}</style>`);
        html = html.replace(new RegExp(`<script[^>]*src=["']${p}["'][^>]*></script>`), `<script>${c}</script>`);
      }
      emit({ type: 'preview', html });
      emit({ type: 'done', summary: s.summary || '', turns: s.turns, toolCalls: s.toolCalls || 0, tokens: s.usage, model: MODEL });
      s.status = 'done';
    }
  } catch (e) {
    emit({ type: 'error', text: e.message });
    s.status = 'error';
  }
}
