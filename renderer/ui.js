/* ui.js — pure render functions, one per tab. Each returns an HTML string (or
 * mounts the canvas, for Studio). Kept dumb: app.js owns routing + state.
 */
(function () {
  // agent accent colors (worker ids; also used for feed rows)
  const ACCENT = {
    strategist: 'var(--a-strategist)', generator: 'var(--a-generator)',
    creator: 'var(--a-creator)', poster: 'var(--a-poster)'
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- CONTENT: the pipeline as a simple ordered workflow ---------------------
  function flowAgent(id, name, does, runHint, sub) {
    return `
      <div class="flow-agent" data-agent-worker="${id}" data-node="${id}" style="--ac:${ACCENT[id]}" title="${esc(does)}">
        <div class="fa-top">
          <span class="pn-dot poll-dot"></span>
          <span class="fa-name">${name}</span>
          <span class="pn-state poll-label">…</span>
        </div>
        ${sub || ''}
        <div class="pn-activity" data-activity="${id}">—</div>
        <div class="fa-ctl">
          <button type="button" class="btn sm pn-run" data-run="${id}" title="${runHint}">▶ run</button>
          <button type="button" class="poll-switch" data-poll-switch title="auto-polling on/off"></button>
        </div>
      </div>`;
  }
  const qChip = (state, label) => `<span class="q-chip"><b data-count="${esc(state)}">–</b> ${label || esc(state)}</span>`;
  function flowStep(n, title, hint, inner) {
    return `
      <div class="flow-step">
        <div class="fs-head"><span class="fs-n">${n}</span><span class="fs-title">${title}</span></div>
        <p class="fs-hint">${hint}</p>
        ${inner}
      </div>`;
  }
  function content() {
    return `
      <section class="page">
        <div class="page-head">
          <span class="eyebrow">pipeline</span>
          <h1>Content</h1>
          <p>What happens, in order. Flip a switch to pause a step; ▶ runs one by hand.</p>
        </div>
        <div class="flow pipe-flow">
          ${flowStep(1, 'Hooks', 'The Strategist wakes on schedule, reads performance, and writes a hook per account (plus a bench spare).',
            `<div class="fs-meta">⏰ <span id="clockTimes">–</span></div>` +
            flowAgent('strategist', 'Strategist', 'Pulls channel analytics, writes hooks from the playbook + past performance, opens the run ticket.', 'run now (ignores the schedule)'))}
          <div class="flow-arrow" aria-hidden="true"></div>
          ${flowStep(2, 'Concepts', 'Each hook becomes a full post concept — script, caption, hashtags.',
            flowAgent('generator', 'Generator', 'One concept per hook, verbatim. Assigned concepts continue automatically; the bench waits for your approval on the Board.', 'process the queue once (auto-poll must be off)') +
            `<div class="fs-meta">${qChip('Generation Queue', 'queued')} ${qChip('Needs Approval', 'bench, awaiting you')}</div>`)}
          <div class="flow-arrow" aria-hidden="true"></div>
          ${flowStep(3, 'Images', 'Slides render per account — UGC photos or graphic cards, per each profile.',
            flowAgent('creator', 'Creator', 'Renders the 9:16 slides for each concept\u2019s account using its reference images or design system.', 'process the queue once (auto-poll must be off)', '<span class="pn-sub" id="pipeModel">…</span>') +
            `<div class="fs-meta">${qChip('Creation Queue', 'queued')} ${qChip('Ready to Post', 'fix-lane')}</div>`)}
          <div class="flow-arrow" aria-hidden="true"></div>
          ${flowStep(4, 'Schedule', 'Posts slot into each account\u2019s posting times via Postiz.',
            flowAgent('poster', 'Poster', 'Uploads slides + caption and schedules into the account\u2019s next open slot. Incomplete sets bounce to the fix-lane.', 'process the queue once (auto-poll must be off)') +
            `<div class="fs-meta">${qChip('Posting Queue', 'queued')}</div>`)}
          <div class="flow-arrow" aria-hidden="true"></div>
          ${flowStep(5, 'Live', 'At the slot time each post lands in its account\u2019s TikTok inbox — finish + publish in the app. Tickets confirm as Published automatically.',
            `<div class="fs-meta big">${qChip('Drafted', 'in TikTok inbox')} ${qChip('Published', 'published')}</div>`)}
        </div>
      </section>`;
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
  const mdImg = (line) => line.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_, url) =>
    `<img class="md-img" loading="lazy" src="${/^https:\/\/uploads\.linear\.app\//.test(url) ? '/api/asset?url=' + encodeURIComponent(url) : esc(url)}" />`);
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
      if (/!\[[^\]]*\]\(/.test(line)) { closeList(); html += mdImg(line); continue; }
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
  function settings() {
    return `
      <p class="es-sub setup-note">API keys the agents use at runtime, autopilot run times, and the daily-report time.</p>
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
            <div class="sr-text">RevenueCat<small>daily report — secret API key (v2) + project id (app.revenuecat.com)</small></div>
            <div class="key-field">
              <input class="field" type="password" data-secret="REVENUECAT_API_KEY" placeholder="sk_…" autocomplete="off" spellcheck="false" />
              <button class="btn sm" data-save-secret="REVENUECAT_API_KEY">Save</button>
              <span class="key-status" data-status="REVENUECAT_API_KEY">…</span>
            </div>
          </div>
          <div class="set-row">
            <div class="sr-text">RevenueCat project id<small>Projects → settings → id (proj…)</small></div>
            <div class="key-field">
              <input class="field" type="password" data-secret="REVENUECAT_PROJECT_ID" placeholder="proj…" autocomplete="off" spellcheck="false" />
              <button class="btn sm" data-save-secret="REVENUECAT_PROJECT_ID">Save</button>
              <span class="key-status" data-status="REVENUECAT_PROJECT_ID">…</span>
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
          <h3>Daily report</h3>
          <p class="desc">Once a day the server collects RevenueCat + channel metrics and posts a digest to Discord. The Report tab always computes live from the collected data.</p>
          <div class="set-row">
            <div class="sr-text">Collect + digest at</div>
            <div class="key-field">
              <input type="time" class="field" data-config-time="reportTime" value="08:00" />
              <span class="key-status" data-config-status="reportTime">…</span>
            </div>
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
      <p class="es-sub setup-note">What the app is — injected into every agent prompt. brief = "what the app is", ticket = "this specific angle".</p>
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

  function board() {
    return `
      <section class="page">
        <div class="page-head">
          <span class="eyebrow">the board</span>
          <h1>Board</h1>
          <p>Everything on the Linear board, actionable from here — review posts (images inline), regen by comment, move tickets, and create new generation tickets. <span class="es-sub">Linear stays the system of record; you just never have to open it.</span></p>
        </div>
        <div class="board-cols" id="boardCols"></div>
        <div class="card set-card" id="newTicketCard">
          <h3>➕ New generation ticket</h3>
          <p class="desc">Lands in Generation Queue — the Generator fans it into concept variations. Attach screenshots of winning posts to adapt them.</p>
          <div class="fieldrow"><input class="field field-full" id="ntTitle" placeholder="title — e.g. gut health morning routine (adapt reference)" /></div>
          <div class="fieldrow"><textarea class="field-area" id="ntDetails" placeholder="context, angle requests, constraints…"></textarea></div>
          <div class="fieldrow nt-row">
            <label>variations <input type="number" class="field nt-num" id="ntCount" value="3" min="1" max="8" /></label>
            <label class="nt-check"><input type="checkbox" id="ntGraphic" /> graphic profile</label>
            <label class="btn sm ref-add">+ screenshots<input type="file" id="ntImages" accept="image/*" multiple hidden /></label>
            <span class="es-sub" id="ntImgCount"></span>
            <button type="button" class="btn primary" id="ntCreate">Create ticket</button>
            <span class="key-status" id="ntStatus"></span>
          </div>
        </div>
        <div id="boardList"><div class="empty-state">Pick a column above.</div></div>
      </section>`;
  }

  function calendar() {
    return `
      <section class="page">
        <div class="page-head">
          <span class="eyebrow">schedule</span>
          <h1>Calendar</h1>
          <p>Every scheduled post by day (Postiz slot time). When you\u2019ve finished + published one in the TikTok app, mark it published here.</p>
        </div>
        <div class="cal-bar">
          <button type="button" class="btn sm" id="calPrev">‹</button>
          <h2 class="cal-month" id="calMonth">…</h2>
          <button type="button" class="btn sm" id="calNext">›</button>
          <span class="cal-legend"><i class="st-dot sched"></i>scheduled <i class="st-dot delivered"></i>in inbox <i class="st-dot published"></i>published <i class="st-dot error"></i>error</span>
        </div>
        <div class="cal-grid" id="calGrid"><div class="empty-state">Loading…</div></div>
      </section>`;
  }

  function home() {
    return `
      <section class="page">
        <div class="page-head">
          <span class="eyebrow">good to see you</span>
          <h1>Today</h1>
          <p class="es-sub" id="repMeta"></p>
        </div>
        <div class="rep-tabs" id="homeTabs">
          <button type="button" class="btn sm rep-tab active" data-rep="overview">Overview</button>
          <button type="button" class="btn sm rep-tab" data-rep="business">Business</button>
          <button type="button" class="btn sm rep-tab" data-rep="channels">Channels</button>
          <button type="button" class="btn sm rep-tab" data-rep="content">Content</button>
        </div>
        <div id="homeOverview"><div class="empty-state">Loading…</div></div>
        <div id="reportRoot" hidden></div>
        <div class="cast-actions">
          <button type="button" class="btn" id="repCollect">⟳ Collect now</button>
          <span class="key-status" id="repStatus"></span>
        </div>
      </section>`;
  }

  function setup() {
    return `
      <section class="page">
        <div class="page-head">
          <span class="eyebrow">configuration</span>
          <h1>Setup</h1>
        </div>
        <div class="rep-tabs" id="setupTabs">
          <button type="button" class="btn sm rep-tab active" data-setup="cast">Cast</button>
          <button type="button" class="btn sm rep-tab" data-setup="brand">Brand</button>
          <button type="button" class="btn sm rep-tab" data-setup="keys">Keys & schedules</button>
        </div>
        <div id="setupBody"></div>
      </section>`;
  }

  function cast() {
    return `
        <p class="es-sub setup-note">Each influencer posts to its own TikTok account, with its own reference images, design system, and posting times. Content fans out to every enabled influencer.</p>
        <div id="castList" class="cast-list"></div>
        <div class="cast-actions">
          <button type="button" class="btn" id="castAdd">+ Add influencer</button>
          <button type="button" class="btn primary" id="castSave">Save cast</button>
          <span class="key-status" id="castStatus"></span>
        </div>`;
  }

  window.UI = { home, content, setup, board, calendar, settings, brand, cast, feedItems, feedItem, mdLite };
})();
