/* ui.js — pure render functions, one per tab. Each returns an HTML string (or
 * mounts the canvas, for Studio). Kept dumb: app.js owns routing + state.
 */
(function () {
  const ACCENT = {
    research: 'var(--research)', content: 'var(--content)',
    creation: 'var(--creation)', orchestrator: 'var(--orchestrator)',
    poster: 'var(--poster)',
    generator: 'var(--content)' // the generator worker == content role (amber)
  };
  const STATE_LABEL = {
    idle: 'wandering', thinking: 'thinking', calling_tool: 'calling tool',
    waiting: 'waiting on job', error: 'error'
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- STUDIO: pipeline dataflow graph --------------------------------------
  // The Floor is a top-down node graph: the main spine (clock → agents → queues →
  // TikTok) in the middle column, datastores on the left, the bench branch on the
  // right, and the analytics feedback loop drawn back up the right lane. Edges are
  // real SVG paths computed from the rendered node positions (app.js drawPipeEdges).
  function gAgent(id, role, name, does, runHint, area, sub) {
    return `
      <div class="pipe-node" data-g="${id}" data-agent-worker="${id}" data-node="${id}" style="--ac:${ACCENT[role]}; grid-area:${area}" title="${esc(does)}">
        <div class="pn-top">
          <span class="pn-dot poll-dot"></span>
          <span class="pn-name">${name}</span>
        </div>
        <span class="pn-state poll-label">…</span>
        ${sub || ''}
        <div class="pn-activity" data-activity="${id}">—</div>
        <div class="pn-ctl">
          <button type="button" class="btn sm pn-run" data-run="${id}" title="${runHint}">▶ run</button>
          <button type="button" class="poll-switch" data-poll-switch title="auto-polling on/off"></button>
        </div>
      </div>`;
  }
  const gQueue = (key, stateName, area, opts = {}) => `
    <div class="pipe-queue ${opts.cls || ''}" data-g="${key}" style="grid-area:${area}" ${opts.title ? `title="${esc(opts.title)}"` : ''}>
      ${opts.gate ? '<span class="pq-gate">👤</span>' : ''}
      <span class="pq-count" data-count="${esc(stateName)}">–</span>
      <span class="pq-name">${opts.label || esc(stateName)}</span>
    </div>`;
  const gStore = (key, area, name, statHtml, flow) => `
    <div class="pipe-store" data-g="${key}" style="grid-area:${area}" title="${esc(flow)}">
      <span class="st-name">${name}</span>
      ${statHtml}
    </div>`;

  function studio(state) {
    return `
      <div class="studio pipeline">
        <div class="pipe-graph pipe-flow">
          <svg class="pipe-edges" aria-hidden="true"></svg>
          <div class="pipe-queue clock" data-g="clock" style="grid-area: 1 / 2" title="The Strategist fires at these times (Settings → Autopilot). Runs/day = posts/day per influencer.">
            <span class="pq-gate">⏰</span>
            <span class="pq-name" id="clockTimes">–</span>
          </div>
          ${gAgent('strategist', 'research', 'Strategist',
            'Pulls Postiz channel analytics, writes 3 hooks (playbook + past performance), assigns one per influencer + a bench, opens the autopilot ticket.',
            'force a run now (ignores the schedule)', '2 / 2')}
          ${gQueue('q_gen', 'Generation Queue', '3 / 2', { label: 'Generation Queue' })}
          ${gAgent('generator', 'content', 'Generator',
            'One concept per hook (verbatim). Assigned concepts skip approval; the bench waits in Needs Approval.',
            'process the queue once (only when auto-poll is off)', '4 / 2')}
          ${gQueue('bench', 'Needs Approval', '5 / 3', { label: 'Needs Approval<br/>(bench)', title: 'Unassigned bench concepts wait here — approve one to send it to the Creator.' })}
          ${gQueue('q_creation', 'Creation Queue', '5 / 2', { label: 'Creation Queue' })}
          ${gAgent('creator', 'creation', 'Creator',
            'Generates the 9:16 slides for each concept\u2019s assigned influencer (UGC photos or graphic cards per the account profile), then opens the post ticket.',
            'process the queue once (only when auto-poll is off)', '6 / 2',
            '<span class="pn-sub" id="pipeModel">…</span>')}
          ${gQueue('q_ready', 'Ready to Post', '7 / 2', { gate: true, label: 'Ready to Post', title: 'You review here — comment \u201cregen N: \u2026\u201d to redo a slide, move the ticket on to approve.' })}
          ${gQueue('q_posting', 'Posting Queue', '8 / 2', { label: 'Posting Queue' })}
          ${gAgent('poster', 'poster', 'Poster',
            'Uploads slides + caption to Postiz and schedules into the character\u2019s next open slot (UPLOAD → TikTok inbox, never live).',
            'process the queue once (only when auto-poll is off)', '9 / 2')}
          ${gQueue('tiktok', 'Drafted', '10 / 2', { cls: 'done', label: '📱 TikTok inbox', title: 'Delivered to the account\u2019s TikTok inbox at the slot time — finish overlays + publish in the app.' })}

          ${gStore('st_store', '2 / 1', '🗄 store',
            '<span class="st-stat" id="storeStats">–</span>',
            'hooks · posts · metrics (Postgres). The Strategist reads past hooks + performance and writes new ones; the Poster records every scheduled post.')}
          ${gStore('st_cast', '6 / 1', '🎭 Cast',
            '<span class="st-stat" id="castStats">–</span>',
            'Influencers: reference images, design systems, TikTok accounts, timeslots. The Creator reads refs/design; the Poster reads accounts + slots.')}
          ${gStore('st_outputs', '8 / 1', '🖼 outputs/',
            '<span class="st-stat">generated slides</span>',
            'The generated 9:16 slides. Creator writes, Poster uploads to Postiz.')}
        </div>
      </div>`;
  }

  function feedItem(l) {
    return `
      <div class="feed-item" data-id="${l.id}" style="--ac:${ACCENT[l.agent] || 'var(--text-faint)'}">
        <span class="fdot"></span>
        <div>
          <span class="ftool">${esc(l.agent)}.${esc(l.tool)}</span>
          <div class="fmsg">${esc(l.msg)}</div>
          <span class="ftime">${l.t}</span>
        </div>
      </div>`;
  }
  function feedItems(log) {
    if (!log.length) return '<div class="feed-empty">Waiting for agent activity…</div>';
    return log.map(feedItem).join('');
  }

  // minimal markdown -> HTML for the generated-concept comments
  function mdLite(md) {
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/(^|[^_])_([^_]+?)_/g, '$1<em>$2</em>');
    let html = '', inList = false;
    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
    for (const raw of String(md).split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { closeList(); continue; }
      if (/^###\s+/.test(line)) { closeList(); html += `<h4>${inline(line.replace(/^###\s+/, ''))}</h4>`; }
      else if (/^##\s+/.test(line)) { closeList(); html += `<h3>${inline(line.replace(/^##\s+/, ''))}</h3>`; }
      else if (/^#\s+/.test(line)) { closeList(); html += `<h3>${inline(line.replace(/^#\s+/, ''))}</h3>`; }
      else if (/^>\s?/.test(line)) { closeList(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; }
      else if (/^---+$/.test(line)) { closeList(); html += '<hr/>'; }
      else if (/^(\d+\.|[-*])\s+/.test(line)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(line.replace(/^(\d+\.|[-*])\s+/, ''))}</li>`; }
      else { closeList(); html += `<p>${inline(line)}</p>`; }
    }
    closeList();
    return html;
  }

  // ---- APPROVALS (real Linear "Needs Approval" tickets) ---------------------
  function approvals(list, error) {
    const items = list || [];
    const head = `
      <div class="page-head">
        <span class="eyebrow">approval gate</span>
        <h1>Approve before spend</h1>
        <p>Real tickets in <b>Needs Approval</b> on the CON board. Approving moves the ticket to <b>Creation Queue</b>; nothing spends Higgsfield credits until then.</p>
      </div>`;

    if (error) {
      return head + `<div class="empty-state">Couldn't reach Linear: ${esc(error)}<br/><span class="es-sub">Check your Linear key in Settings.</span></div>`;
    }
    if (items.length === 0) {
      return head + `<div class="empty-state">Nothing awaiting approval.<br/><span class="es-sub">Generated concepts land here for review.</span></div>`;
    }

    const cards = items.map(a => `
      <div class="card approve-card" data-approve="${a.id}">
        <div class="ac-tophead">
          <span class="ac-ident">${esc(a.identifier)}</span>
          <span class="ac-concept">${esc(a.title)}</span>
          ${a.url ? `<a class="ac-link" href="${esc(a.url)}" target="_blank" rel="noreferrer">open ↗</a>` : ''}
        </div>
        <div class="ac-concepts">${a.concepts ? mdLite(a.concepts) : '<span class="es-sub">No concepts posted yet.</span>'}</div>
        <div class="ac-actions">
          <button class="btn ok" data-act="approve" data-id="${a.id}">Approve → Creation</button>
          <button class="btn danger sm" data-act="reject" data-id="${a.id}">Reject</button>
        </div>
      </div>`).join('');

    return head +
      `<div class="gate-banner">
        <span class="gb-ico">⏸</span>
        <span class="gb-text"><b>${items.length}</b> ticket${items.length === 1 ? '' : 's'} awaiting review</span>
      </div>
      <div class="approve-list">${cards}</div>`;
  }

  // ---- AGENTS ---------------------------------------------------------------
  function agentsPage(state) {
    const cards = state.agents.map(a => `
      <div class="card agent-card ${a.workerId ? '' : 'unbuilt'}" style="--ac:${ACCENT[a.role]}">
        <div class="acard-head">
          <div class="acard-avatar"><canvas data-avatar="${a.role}" width="42" height="42"></canvas></div>
          <div>
            <div class="acard-name">${a.name}</div>
            <div class="acard-title">${esc(a.title)}</div>
          </div>
          ${a.workerId
            ? `<div class="poll" data-agent-worker="${a.workerId}"><span class="poll-dot"></span><span class="poll-label">…</span><div class="switch" data-poll-switch><i></i></div></div>`
            : `<span class="acard-state muted">not built</span>`}
        </div>
        ${a.model ? `
        <div class="acard-rows">
          <div class="acard-row"><span class="k">Model</span><span class="v model">${esc(a.model)}</span></div>
          ${a.tools ? `<div class="acard-row" style="display:block"><span class="k">Tools</span><div class="tools">${a.tools.map(t => `<span class="tool-tag">${esc(t)}</span>`).join('')}</div></div>` : ''}
        </div>` : ''}
        ${a.prompt ? `<div class="prompt-box"><span class="pb-label">system prompt</span>${esc(a.prompt)}</div>` : ''}
      </div>`).join('');
    return `
      <div class="page-head">
        <span class="eyebrow">agent roster</span>
        <h1>Agents</h1>
        <p>The workers that run your pipeline. Toggle polling per agent. Only built agents run — the rest are placeholders for what's coming.</p>
      </div>
      <div class="agents-grid">${cards}</div>`;
  }

  // ---- LOGS -----------------------------------------------------------------
  function logs(state) {
    const rows = state.log.map(l => `
      <div class="log-row" style="--ac:${ACCENT[l.agent] || 'var(--text-faint)'}">
        <span class="lt">${l.t}</span>
        <span class="la">${esc(l.agent)}</span>
        <span class="ltool">${esc(l.tool)}</span>
        <span class="lm">${esc(l.msg)}</span>
      </div>`).join('') || '<div class="feed-empty">No activity yet.</div>';
    return `
      <div class="page-head">
        <span class="eyebrow">event stream</span>
        <h1>Logs</h1>
        <p>Live output from the agent workers, newest first.</p>
      </div>
      <div class="card log-wrap" id="logWrap">${rows}</div>`;
  }

  // ---- SETTINGS -------------------------------------------------------------
  function settings() {
    return `
      <div class="page-head">
        <span class="eyebrow">configuration</span>
        <h1>Settings</h1>
        <p>Credentials the agents use. Stored locally in <code>~/.sweatshop/secrets.json</code> — nothing leaves this machine.</p>
      </div>
      <div class="settings">
        <div class="card set-card">
          <h3>Keys</h3>
          <p class="desc">Read by the agents at runtime.</p>
          <div class="set-row">
            <div class="sr-text">Anthropic API key<small>every agent's Claude calls</small></div>
            <div class="key-field">
              <input class="field" type="password" data-secret="ANTHROPIC_API_KEY" placeholder="sk-ant-…" autocomplete="off" spellcheck="false" />
              <button class="btn sm" data-save-secret="ANTHROPIC_API_KEY">Save</button>
              <span class="key-status" data-status="ANTHROPIC_API_KEY">…</span>
            </div>
          </div>
          <div class="set-row">
            <div class="sr-text">Linear API key<small>generator reads the board (team CON)</small></div>
            <div class="key-field">
              <input class="field" type="password" data-secret="LINEAR_API_KEY" placeholder="lin_api_…" autocomplete="off" spellcheck="false" />
              <button class="btn sm" data-save-secret="LINEAR_API_KEY">Save</button>
              <span class="key-status" data-status="LINEAR_API_KEY">…</span>
            </div>
          </div>
          <div class="set-row">
            <div class="sr-text">Gemini API key<small>Creator agent — image generation (Nano Banana Pro; aistudio.google.com)</small></div>
            <div class="key-field">
              <input class="field" type="password" data-secret="GEMINI_API_KEY" placeholder="AIza…" autocomplete="off" spellcheck="false" />
              <button class="btn sm" data-save-secret="GEMINI_API_KEY">Save</button>
              <span class="key-status" data-status="GEMINI_API_KEY">…</span>
            </div>
          </div>
          <div class="set-row">
            <div class="sr-text">OpenAI API key<small>Creator agent — image generation (GPT Image; platform.openai.com)</small></div>
            <div class="key-field">
              <input class="field" type="password" data-secret="OPENAI_API_KEY" placeholder="sk-…" autocomplete="off" spellcheck="false" />
              <button class="btn sm" data-save-secret="OPENAI_API_KEY">Save</button>
              <span class="key-status" data-status="OPENAI_API_KEY">…</span>
            </div>
          </div>
          <div class="set-row">
            <div class="sr-text">Postiz API key<small>Poster agent — publishes to TikTok (postiz.com)</small></div>
            <div class="key-field">
              <input class="field" type="password" data-secret="POSTIZ_API_KEY" placeholder="postiz key…" autocomplete="off" spellcheck="false" />
              <button class="btn sm" data-save-secret="POSTIZ_API_KEY">Save</button>
              <span class="key-status" data-status="POSTIZ_API_KEY">…</span>
            </div>
          </div>
          <div class="set-row">
            <div class="sr-text">Discord webhook<small>alerts — step starts, posts ready for approval, scheduled posts, failures (channel → Integrations → Webhooks)</small></div>
            <div class="key-field">
              <input class="field" type="password" data-secret="DISCORD_WEBHOOK_URL" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" spellcheck="false" />
              <button class="btn sm" data-save-secret="DISCORD_WEBHOOK_URL">Save</button>
              <span class="key-status" data-status="DISCORD_WEBHOOK_URL">…</span>
            </div>
          </div>
        </div>
        <div class="card set-card">
          <h3>Autopilot</h3>
          <p class="desc">The Strategist runs at these times each day: it refreshes analytics, writes 3 hooks, and kicks off a full run — one imaged post per influencer + one bench concept. Runs per day = posts per day per influencer. No times = autopilot idle. (Enable the Strategist on the Agents tab.)</p>
          <div class="set-row">
            <div class="sr-text">Run times<small>make sure each character has at least this many daily slots on the Cast tab</small></div>
            <div class="slots" id="autopilotSlots"></div>
          </div>
        </div>
        <div class="card set-card">
          <h3>Image model</h3>
          <p class="desc">Which model the Creator agent uses to render slideshow images. Applies on its next poll — either way, character consistency uses your reference images.</p>
          <div class="set-row">
            <div class="sr-text">Creator image model<small>Nano Banana Pro needs the Gemini key · GPT Image needs the OpenAI key</small></div>
            <div class="key-field">
              <select class="field" data-config="imageModel">
                <option value="gemini">Nano Banana Pro (Gemini)</option>
                <option value="openai">GPT Image (OpenAI)</option>
              </select>
              <span class="key-status" data-config-status="imageModel">…</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ---- BRAND ----------------------------------------------------------------
  function brand() {
    return `
      <div class="page-head">
        <span class="eyebrow">product context</span>
        <h1>Brand</h1>
        <p>What the agents make content for. This brief is injected into every agent — Research finds angles that fit it, the Generator writes in this voice, Creation matches the look. Filled once, used everywhere.</p>
      </div>
      <form id="brandForm" class="brand-form" onsubmit="return false">
        <div class="card set-card">
          <h3>Product</h3>
          <div class="fieldrow"><label>Name</label><input class="field field-full" name="name" placeholder="e.g. Sweatshop" /></div>
          <div class="fieldrow"><label>One-liner<small>the hook in a sentence</small></label><input class="field field-full" name="oneLiner" placeholder="e.g. an agentic content studio for solo founders" /></div>
          <div class="fieldrow"><label>What it does</label><textarea class="field-area" name="description" placeholder="A couple sentences: what the app is and how it works."></textarea></div>
          <div class="fieldrow"><label>Link<small>app store / site</small></label><input class="field field-full" name="url" placeholder="https://" /></div>
          <div class="fieldrow"><label>Audience<small>who it's for, where they scroll</small></label><textarea class="field-area" name="audience" placeholder="e.g. indie developers and solo founders on TikTok & X"></textarea></div>
          <div class="fieldrow"><label>Value props / pain points<small>what it solves</small></label><textarea class="field-area" name="valueProps"></textarea></div>
        </div>
        <div class="card set-card">
          <h3>Content & style</h3>
          <div class="fieldrow"><label>Voice<small>tone + a couple example phrases</small></label><textarea class="field-area" name="voice"></textarea></div>
          <div class="fieldrow"><label>Visual identity<small>colors, aesthetic, imagery do/don't — used by Creation</small></label><textarea class="field-area" name="visual"></textarea></div>
          <div class="fieldrow"><label>Content pillars<small>one per line — your recurring buckets</small></label><textarea class="field-area" name="pillars" placeholder="Feature spotlight — a feature solving a real pain
Founder POV — building in public
Myth-bust — correct a common belief"></textarea></div>
          <div class="fieldrow"><label>Goals<small>what every post should drive</small></label><textarea class="field-area" name="goals" placeholder="e.g. waitlist signups"></textarea></div>
          <div class="fieldrow"><label>Guardrails<small>never say / avoid / compliance</small></label><textarea class="field-area" name="guardrails"></textarea></div>
        </div>
        <div class="card set-card">
          <h3>Per-agent directions</h3>
          <p class="desc">Role-specific instructions layered on the product brief. Blank = agent uses the product brief only. Creation's constraints also steer what the Generator suggests.</p>
          <div class="fieldrow"><label>Researcher<small>what to look for, sources, cadence</small></label><textarea class="field-area" name="agent_researcher"></textarea></div>
          <div class="fieldrow"><label>Generator<small>concept style, do / don't</small></label><textarea class="field-area" name="agent_generator"></textarea></div>
          <div class="fieldrow"><label>Creation<small>e.g. images only, which styles &amp; formats</small></label><textarea class="field-area" name="agent_creation" placeholder="Only generate images — no video. UGC selfie style, natural lighting, 9:16."></textarea></div>
        </div>
        <div class="brand-actions">
          <button type="button" class="btn primary" id="brandSave">Save brief</button>
          <span class="key-status" id="brandStatus"></span>
        </div>
      </form>`;
  }

  function cast() {
    return `
      <section class="page">
        <div class="page-head">
          <span class="eyebrow">the cast</span>
          <h1>Influencers</h1>
          <p>Each influencer posts to its own TikTok account, with its own reference images and daily posting times. Generated content fans out to every <em>enabled</em> influencer, and their posts fill each character's open time slots across days.</p>
        </div>
        <div id="castList" class="cast-list"></div>
        <div class="cast-actions">
          <button type="button" class="btn" id="castAdd">+ Add influencer</button>
          <button type="button" class="btn primary" id="castSave">Save cast</button>
          <span class="key-status" id="castStatus"></span>
        </div>
      </section>`;
  }

  window.UI = { studio, feedItems, feedItem, approvals, agentsPage, logs, settings, brand, cast };
})();
