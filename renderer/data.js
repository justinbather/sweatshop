/* data.js — client-side state.
 * Real data streams in from the agent workers (activity log, via the main
 * process) and from Linear (approvals). The agent roster below is static config
 * for the office view + Agents page. No mock or simulated data.
 */

const AGENTS = [
  {
    id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', status: 'idle',
    title: 'Plans the run, holds the budget'
  },
  {
    id: 'research', name: 'Strategist', role: 'research', workerId: 'strategist', status: 'idle',
    title: 'Autopilot clock — analytics in, hooks out',
    model: 'claude-opus-4-8',
    tools: ['pull_analytics', 'write_hooks', 'create_ticket'],
    prompt: 'On each scheduled run (Settings → Autopilot): pull channel analytics from Postiz into the store, write 3 fresh hooks from the TikTok-hooks playbook + past performance, assign one to each influencer (rest bench), and create the autopilot ticket that kicks off Generator → Creator → Poster.'
  },
  {
    id: 'content', name: 'Generator', role: 'content', workerId: 'generator', status: 'idle',
    title: 'Fans briefs into concept variations; revises on request',
    model: 'claude-opus-4-8',
    tools: ['read_ticket', 'read_screenshots', 'generate_concepts', 'create_variations', 'comment', 'move_state'],
    prompt: 'Turn each Generation Queue ticket into N distinct on-brand slideshow concepts, adapting any reference screenshots. Fan out into sub-issue variations for review; revise a concept when asked.'
  },
  {
    id: 'creation', name: 'Creator', role: 'creation', workerId: 'creator', status: 'idle',
    title: 'Generates slideshow images via Nano Banana Pro or GPT Image',
    model: 'Nano Banana Pro / GPT Image',
    tools: ['read_concept', 'generate_image', 'upload_image', 'create_post_ticket', 'move_state'],
    prompt: 'Take each approved variation in Creation Queue, generate its slideshow images with Nano Banana Pro using the reference images, then create a linked post ticket in Posting Queue for the Poster.'
  },
  {
    id: 'poster', name: 'Poster', role: 'poster', workerId: 'poster', status: 'idle',
    title: 'Preps TikTok drafts in Postiz (you finish + publish)',
    model: 'Postiz',
    tools: ['read_post', 'upload_media', 'create_draft', 'comment', 'move_state'],
    prompt: 'Take posts approved into Posting Queue and create a TikTok draft in Postiz — images + caption + hashtags — then move to Drafted for you to add overlays and publish. (Draft creation stubbed until Postiz is connected.)'
  }
];

const STATE = {
  agents: AGENTS,
  log: [] // real agent output streams in from the worker
};

const listeners = new Set();
function emit() { listeners.forEach(fn => fn(STATE)); }

window.DATA = {
  STATE,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit
};
