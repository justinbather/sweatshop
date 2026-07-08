/* app.js — controller: nav, routing, live binding, interactions. */
(function () {
  const { STATE, subscribe, emit } = window.DATA;

  let countsCache = {};      // Linear column counts (Board badge + flow chips)
  let agentStatusCache = []; // real agent worker status (from main process)

  // ---- pixel icons (rect grids -> crisp SVG) --------------------------------
  const G = {
    home:    ['00011000','00111100','01111110','11111111','11100111','11100111','11100111','11111111'],
    content: ['11000000','11110000','11111100','11111111','11111100','11110000','11000000','00000000'],
    board:   ['11101110','11101110','00000000','11101110','11101110','00000000','11101110','11101110'],
    setup:   ['00111100','01111110','11100111','11000011','11000011','11100111','01111110','00111100']
  };
  function icon(name, size = 16) {
    const g = G[name] || G.studio; const n = g.length; const cell = size / n;
    let r = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < g[y].length; x++)
      if (g[y][x] === '1') r += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}"/>`;
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="currentColor" shape-rendering="crispEdges">${r}</svg>`;
  }

  const TABS = [
    { id: 'home',    label: 'Home' },
    { id: 'content', label: 'Content' },
    { id: 'board',   label: 'Board', badge: () => countsCache['Needs Approval'] || 0, warn: true },
    { id: 'setup',   label: 'Setup' }
  ];

  let current = 'home';

  // ---- nav ------------------------------------------------------------------
  function renderNav() {
    document.getElementById('nav').innerHTML = TABS.map(t => {
      const b = t.badge ? t.badge() : 0;
      const badge = b ? `<span class="badge ${t.warn ? 'warn' : ''}">${b}</span>` : '';
      return `<li data-tab="${t.id}" class="${t.id === current ? 'active' : ''}">${icon(t.id)}<span>${t.label}</span>${badge}</li>`;
    }).join('');
  }

  // ---- real agent status → topbar pill + floor chips + agent toggles --------
  function pollLabel(st) {
    if (!st) return '—';
    return st.enabled ? (st.running ? 'polling' : 'starting…') : 'paused';
  }
  function updateAgentsUI() {
    const byId = {};
    agentStatusCache.forEach(a => { byId[a.id] = a; });

    document.querySelectorAll('[data-agent-worker]').forEach(el => {
      const id = el.dataset.agentWorker;
      const st = byId[id];
      const sw = el.querySelector('[data-poll-switch]');
      const label = el.querySelector('.poll-label');
      const dot = el.querySelector('.poll-dot');
      if (sw) sw.classList.toggle('on', !!(st && st.enabled));
      if (label) label.textContent = st && st.once ? 'manual run…' : pollLabel(st);
      if (dot) dot.classList.toggle('ok', !!(st && (st.running || st.once)));
      // ▶ run-now: the Strategist can always run (its loop is time-gated);
      // queue agents only step manually while their auto-poller is off.
      const run = el.querySelector('[data-run]');
      if (run) run.disabled = !!(st && (st.once || (id !== 'strategist' && st.enabled)));
    });
  }

  // ---- routing --------------------------------------------------------------
  function render() {
    if (pipeTimer) { clearInterval(pipeTimer); pipeTimer = null; }
    const view = document.getElementById('view');
    switch (current) {
      case 'home':    view.innerHTML = window.UI.home(); mountHome(); break;
      case 'content': view.innerHTML = window.UI.content(); mountContent(); break;
      case 'board':   view.innerHTML = window.UI.board(); mountBoard(); break;
      case 'setup':   view.innerHTML = window.UI.setup(); mountSetup('cast'); break;
    }
    renderNav();
    updateAgentsUI();
  }

  // ---- setup: Cast / Brand / Keys & schedules under one roof -----------------
  function mountSetup(which) {
    const body = document.getElementById('setupBody');
    const tabs = document.getElementById('setupTabs');
    if (!body) return;
    const show = (w) => {
      if (w === 'cast') { body.innerHTML = window.UI.cast(); mountCast(); }
      else if (w === 'brand') { body.innerHTML = window.UI.brand(); mountBrand(); }
      else { body.innerHTML = window.UI.settings(); mountSettings(); }
    };
    if (tabs && !tabs.dataset.bound) {
      tabs.dataset.bound = '1';
      tabs.addEventListener('click', (e) => {
        const t = e.target.closest('[data-setup]');
        if (!t) return;
        tabs.querySelectorAll('.rep-tab').forEach(b => b.classList.toggle('active', b === t));
        show(t.dataset.setup);
      });
    }
    show(which);
  }


  // ---- pipeline graph: SVG edges between the laid-out nodes ------------------
  // Solid = the main flow; dashed = branches; dim dashed = datastore reads/writes.
  // lane 'left'/'right' routes long edges out to a side lane (the feedback loop).
  let pipeTimer = null;
  async function refreshPipeline() {
    const p = window.studio && window.studio.pipeline;
    if (!p) return;
    const [countsRes, stats] = await Promise.all([p.counts(), p.stats()]);
    countsCache = (countsRes && countsRes.counts) || {};
    renderNav(); // Board badge
    document.querySelectorAll('[data-count]').forEach(el => {
      el.textContent = countsCache[el.dataset.count] ?? 0;
      el.classList.toggle('has', (countsCache[el.dataset.count] || 0) > 0);
    });
    const clock = document.getElementById('clockTimes');
    if (clock) clock.textContent = (stats.autopilotTimes.length ? stats.autopilotTimes.join(' · ') : 'no run times set (Setup → Keys & schedules)')
      + (stats.lastRun ? ` — last run ${new Date(stats.lastRun).toLocaleString()}` : '');
    const model = document.getElementById('pipeModel');
    if (model) model.textContent = stats.imageModel;
    return stats;
  }


  function mountContent() {
    const flow = document.querySelector('.pipe-flow');
    if (flow && !flow.dataset.bound) {
      flow.dataset.bound = '1';
      flow.addEventListener('click', async (e) => {
        const api = window.studio && window.studio.agents;
        if (!api) return;
        const run = e.target.closest('[data-run]');
        if (run) {
          run.disabled = true;
          try { agentStatusCache = await api.runOnce(run.dataset.run); }
          catch (err) { alert(err.message || String(err)); run.disabled = false; }
          updateAgentsUI();
          return;
        }
        const sw = e.target.closest('[data-poll-switch]');
        if (sw) {
          const id = sw.closest('[data-agent-worker]').dataset.agentWorker;
          agentStatusCache = await api.setEnabled(id, !sw.classList.contains('on'));
          updateAgentsUI();
        }
      });
    }
    Object.keys(agentActivity).forEach(id => {
      const a = agentActivity[id];
      const act = document.querySelector(`[data-activity="${id}"]`);
      if (act && a.line) act.textContent = a.line.slice(0, 110);
      const node = document.querySelector(`[data-node="${id}"]`);
      if (node) { node.classList.toggle('working', a.kind === 'working'); node.classList.toggle('error', a.kind === 'error'); }
    });
    refreshPipeline();
    if (pipeTimer) clearInterval(pipeTimer);
    pipeTimer = setInterval(refreshPipeline, 30000);
  }


  // ---- board: the full Linear surface -----------------------------------------
  const BOARD_COLS = ['Generation Queue', 'Needs Approval', 'Revise', 'Creation Queue', 'Ready to Post', 'Posting Queue', 'Drafted', 'Published', 'Generated', 'Rejected'];
  // contextual quick actions per column: [label, targetState]
  const BOARD_ACTIONS = {
    'Needs Approval': [['✓ Approve → Creation', 'Creation Queue'], ['↻ Revise', 'Revise'], ['✕ Reject', 'Rejected']],
    'Revise': [['✓ Done → Approval', 'Needs Approval']],
    'Ready to Post': [['→ Posting Queue', 'Posting Queue'], ['✕ Reject', 'Rejected']],
    'Rejected': [['↩ Generation Queue', 'Generation Queue']]
  };
  let boardCol = 'Ready to Post';

  async function mountBoard() {
    const api = window.studio && window.studio.board;
    const cols = document.getElementById('boardCols');
    const list = document.getElementById('boardList');
    if (!api || !cols || !list) return;
    const esc2 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function renderCols(counts) {
      cols.innerHTML = BOARD_COLS.map(c =>
        `<button type="button" class="btn sm bd-col ${c === boardCol ? 'active' : ''}" data-col="${esc2(c)}">${esc2(c)}${counts && counts[c] != null ? ` <b>${counts[c]}</b>` : ''}</button>`).join('');
    }
    renderCols(null);
    if (window.studio.pipeline) window.studio.pipeline.counts().then(r => renderCols((r && r.counts) || {}));

    function ticketCard(t) {
      const quick = (BOARD_ACTIONS[t.state] || []).map(([label, target]) =>
        `<button type="button" class="btn sm" data-bd-move="${esc2(t.id)}" data-target="${esc2(target)}">${esc2(label)}</button>`).join('');
      const moveOpts = BOARD_COLS.filter(c => c !== t.state).map(c => `<option value="${esc2(c)}">${esc2(c)}</option>`).join('');
      const comments = (t.comments || []).map(c =>
        `<div class="bd-comment">${window.UI.mdLite ? window.UI.mdLite(c.body) : esc2(c.body)}</div>`).join('');
      return `
        <div class="card bd-ticket" data-ticket="${esc2(t.id)}">
          <div class="bd-head" data-bd-toggle="${esc2(t.id)}">
            <span class="bd-idf">${esc2(t.identifier)}</span>
            <span class="bd-title">${esc2(t.title)}</span>
            <span class="bd-when">${new Date(t.updatedAt).toLocaleString()}</span>
          </div>
          <div class="bd-body" hidden>
            <div class="bd-desc">${window.UI.mdLite ? window.UI.mdLite(t.description || '_no description_') : esc2(t.description)}</div>
            ${comments ? `<div class="bd-comments"><h4>Comments</h4>${comments}</div>` : ''}
            <div class="bd-actions">
              ${quick}
              <select class="field bd-move-sel" data-bd-sel="${esc2(t.id)}"><option value="">move to…</option>${moveOpts}</select>
              <input class="field bd-comment-in" data-bd-cin="${esc2(t.id)}" placeholder='comment — e.g. "regen 3: fix the typo"' />
              <button type="button" class="btn sm" data-bd-send="${esc2(t.id)}">Send</button>
              <a class="es-sub" href="${esc2(t.url)}" target="_blank">open in Linear ↗</a>
            </div>
          </div>
        </div>`;
    }

    async function loadCol() {
      list.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
        const tickets = await api.list([boardCol]);
        list.innerHTML = tickets.length ? tickets.map(ticketCard).join('') : `<div class="empty-state">Nothing in ${esc2(boardCol)}.</div>`;
      } catch (e) { list.innerHTML = `<div class="empty-state">⚠ ${esc2(e.message || e)}</div>`; }
    }
    await loadCol();

    cols.addEventListener('click', (e) => {
      const b = e.target.closest('[data-col]');
      if (!b) return;
      boardCol = b.dataset.col;
      cols.querySelectorAll('.bd-col').forEach(x => x.classList.toggle('active', x === b));
      loadCol();
    });

    list.addEventListener('click', async (e) => {
      const tog = e.target.closest('[data-bd-toggle]');
      if (tog) { const body = tog.parentElement.querySelector('.bd-body'); if (body) body.hidden = !body.hidden; return; }
      const mv = e.target.closest('[data-bd-move]');
      if (mv) {
        mv.disabled = true;
        try { await api.move(mv.dataset.bdMove, mv.dataset.target); await loadCol(); }
        catch (err) { alert(err.message || err); mv.disabled = false; }
        return;
      }
      const send = e.target.closest('[data-bd-send]');
      if (send) {
        const input = list.querySelector(`[data-bd-cin="${CSS.escape(send.dataset.bdSend)}"]`);
        const body = input && input.value.trim();
        if (!body) return;
        send.disabled = true;
        try { await api.comment(send.dataset.bdSend, body); input.value = ''; send.textContent = '✓ sent'; setTimeout(() => { send.textContent = 'Send'; send.disabled = false; }, 1500); }
        catch (err) { alert(err.message || err); send.disabled = false; }
        return;
      }
    });
    list.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-bd-sel]');
      if (sel && sel.value) {
        const target = sel.value; sel.disabled = true;
        try { await api.move(sel.dataset.bdSel, target); await loadCol(); }
        catch (err) { alert(err.message || err); sel.disabled = false; sel.value = ''; }
      }
    });

    // new-ticket form
    let ntImages = [];
    const imgInput = document.getElementById('ntImages');
    if (imgInput) imgInput.onchange = async () => {
      for (const f of imgInput.files) {
        const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
        ntImages.push(dataUrl);
      }
      imgInput.value = '';
      document.getElementById('ntImgCount').textContent = `${ntImages.length} image(s)`;
    };
    const createBtn = document.getElementById('ntCreate');
    if (createBtn) createBtn.addEventListener('click', async () => {
      const title = document.getElementById('ntTitle').value.trim();
      const status = document.getElementById('ntStatus');
      if (!title) { status.textContent = 'title required'; return; }
      createBtn.disabled = true; status.textContent = 'creating…';
      try {
        const t = await api.create({
          title,
          details: document.getElementById('ntDetails').value.trim(),
          count: Number(document.getElementById('ntCount').value) || 3,
          graphic: document.getElementById('ntGraphic').checked,
          images: ntImages
        });
        status.textContent = `● created ${t.identifier}`; status.classList.add('ok');
        document.getElementById('ntTitle').value = ''; document.getElementById('ntDetails').value = '';
        ntImages = []; document.getElementById('ntImgCount').textContent = '';
        if (boardCol === 'Generation Queue') loadCol();
      } catch (err) { status.textContent = '⚠ ' + (err.message || err); }
      createBtn.disabled = false;
    });
  }

  // ---- report: daily growth report -------------------------------------------
  const RC_NAMES = {
    rc_mrr: 'MRR', rc_active_trials: 'Active trials', rc_active_subscriptions: 'Active subs',
    rc_new_customers: 'New customers', rc_revenue: 'Revenue (28d)', rc_active_users: 'Active users'
  };
  function deltaHtml(d, suffix) {
    if (d == null) return '<span class="delta none">–</span>';
    const v = Math.round(d * 100) / 100;
    return `<span class="delta ${v > 0 ? 'up' : v < 0 ? 'down' : 'none'}">${v > 0 ? '+' : ''}${v}${suffix || ''}</span>`;
  }
  let repSection = 'business';
  function renderReport(r) {
    const esc2 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const biz = r.business.length ? r.business.map(m => `
      <div class="rep-card">
        <span class="rc-label">${esc2(RC_NAMES[m.label] || m.label.replace(/^rc_/, ''))}</span>
        <span class="rc-value">${esc2(m.value)}</span>
        <span class="rc-deltas">${deltaHtml(m.d1)} today · ${deltaHtml(m.d7)} 7d</span>
      </div>`).join('') :
      `<div class="empty-state">No business metrics yet${r.meta.revenuecatConfigured ? ' — hit Collect now' : ' — add the RevenueCat key + project id in Settings, then Collect now'}.</div>`;
    const chans = r.channels.length ? `<table class="rep-table"><tr><th>channel metric</th><th>value</th><th>Δ 7d</th></tr>` +
      r.channels.map(c => `<tr><td>${esc2(c.label)}</td><td>${esc2(c.value)}</td><td>${deltaHtml(c.d7 == null ? c.d1 : c.d7)}</td></tr>`).join('') + '</table>'
      : '<div class="empty-state">No channel metrics yet — they collect with each report run (needs the Postiz key).</div>';
    const stIcon = (s) => s === 'published' ? '🚀' : s === 'delivered' ? '📬' : s === 'error' ? '⚠️' : '⏳';
    const posts = r.content.recentPosts.length ? `<table class="rep-table"><tr><th>ticket</th><th>account</th><th>hook</th><th>scheduled</th><th>status</th></tr>` +
      r.content.recentPosts.map(p => `<tr><td>${esc2(p.ticket)}</td><td>${esc2(p.account)}</td><td class="rt-hook">${esc2((p.hook || '').slice(0, 60))}</td><td>${p.scheduledAt ? new Date(p.scheduledAt).toLocaleString() : '–'}</td><td>${p.releaseUrl ? `<a href="${esc2(p.releaseUrl)}" target="_blank">${stIcon(p.status)} ${esc2(p.status)}</a>` : `${stIcon(p.status)} ${esc2(p.status)}`}</td></tr>`).join('') + '</table>'
      : '<div class="empty-state">No posts recorded yet.</div>';
    if (repSection === 'business') return `<div class="rep-grid">${biz}</div>`;
    if (repSection === 'channels') return `<div class="card set-card rep-section"><h3>Channels</h3>${chans}</div>`;
    return `
      <div class="card set-card rep-section"><h3>Content — last 7 days</h3>
        <p class="desc">${r.content.posts7d} scheduled · ${r.content.published7d ?? 0} published · ${r.content.hooks7d} hook(s) written${r.content.byAccount.length ? ' — ' + r.content.byAccount.map(a => `${esc2(a.name)}: ${a.posts}`).join(' · ') : ''}</p>
        ${posts}
        <p class="desc">Per-post views/likes aren't available yet (channel-level only) — “what's working” sharpens once the attribution survey ships (docs/ATTRIBUTION.md).</p>
      </div>`;
  }
  function renderOverview(r, stats) {
    const esc2 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const order = ['rc_mrr', 'rc_active_subscriptions', 'rc_active_trials', 'rc_new_customers'];
    const byLabel = Object.fromEntries(r.business.map(m => [m.label, m]));
    const picks = order.map(k => byLabel[k]).filter(Boolean);
    const biz = (picks.length ? picks : r.business.slice(0, 4)).map(m => `
      <div class="rep-card">
        <span class="rc-label">${esc2(RC_NAMES[m.label] || m.label.replace(/^rc_/, ''))}</span>
        <span class="rc-value">${esc2(m.value)}</span>
        <span class="rc-deltas">${deltaHtml(m.d1)} today · ${deltaHtml(m.d7)} 7d</span>
      </div>`).join('')
      || `<div class="empty-state">No business metrics yet${r.meta.revenuecatConfigured ? ' — hit Collect now' : ' — add the RevenueCat key in Setup, then Collect now'}.</div>`;
    const upcoming = (stats.upcoming || []).map(u => `
      <li><b>${new Date(u.scheduledAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</b>
          ${esc2(u.account)} <span class="es-sub">${esc2(u.ticket)}</span></li>`).join('')
      || '<li class="es-sub">Nothing scheduled — run the Strategist on the Content page.</li>';
    return `
      <div class="rep-grid">${biz}</div>
      <div class="ov-grid">
        <div class="ov-card">
          <h3>📅 Next posts</h3>
          <ul class="ov-list">${upcoming}</ul>
        </div>
        <div class="ov-card">
          <h3>⚙️ Rhythm</h3>
          <ul class="ov-list">
            <li>Autopilot runs: <b>${stats.autopilotTimes.length ? stats.autopilotTimes.join(' · ') : 'not set'}</b></li>
            <li>Daily report: <b>${esc2(r.meta.reportTime)}</b></li>
            <li>Image model: <b>${esc2(stats.imageModel)}</b></li>
            <li>Accounts: <b>${(stats.influencers || []).join(', ') || 'none'}</b></li>
          </ul>
        </div>
        <div class="ov-card">
          <h3>📮 Last 7 days</h3>
          <ul class="ov-list">
            <li>Posts scheduled: <b>${r.content.posts7d}</b></li>
            <li>Confirmed published: <b>${r.content.published7d ?? 0}</b></li>
            <li>Hooks written: <b>${r.content.hooks7d}</b></li>
            <li>Awaiting your approval: <b>${countsCache['Needs Approval'] || 0}</b> <span class="es-sub">(Board)</span></li>
          </ul>
        </div>
      </div>`;
  }

  async function mountHome() {
    const api = window.studio && window.studio.report;
    const root = document.getElementById('reportRoot');
    const overview = document.getElementById('homeOverview');
    if (!api || !root || !overview) return;
    const meta = document.getElementById('repMeta');
    const status = document.getElementById('repStatus');
    let cached = null, statsCached = null;
    repSection = 'overview';
    async function load(r) {
      if (!r) r = await api.get();
      cached = r;
      if (!statsCached) statsCached = (await refreshPipeline()) || { autopilotTimes: [], influencers: [], imageModel: '', upcoming: [] };
      paint();
      if (meta) meta.textContent = `Last collected ${r.meta.lastCollected ? new Date(r.meta.lastCollected).toLocaleString() : 'never'} · daily report at ${r.meta.reportTime}`;
    }
    function paint() {
      if (repSection === 'overview') {
        overview.hidden = false; root.hidden = true;
        overview.innerHTML = renderOverview(cached, statsCached);
      } else {
        overview.hidden = true; root.hidden = false;
        root.innerHTML = renderReport(cached);
      }
    }
    await load();
    const tabs = document.getElementById('homeTabs');
    if (tabs) tabs.addEventListener('click', (e) => {
      const t = e.target.closest('[data-rep]');
      if (!t || !cached) return;
      repSection = t.dataset.rep;
      tabs.querySelectorAll('.rep-tab').forEach(b => b.classList.toggle('active', b === t));
      paint();
    });
    const btn = document.getElementById('repCollect');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true; status.textContent = 'collecting…';
      try {
        const res = await api.collect();
        await load(res.report);
        status.textContent = '● ' + (res.notes || []).join(' · ');
      } catch (e) { status.textContent = '⚠ ' + (e.message || e); }
      btn.disabled = false;
    });
  }


  // ---- brand: load/save the product brief -----------------------------------
  async function mountBrand() {
    const api = window.studio && window.studio.brief;
    const form = document.getElementById('brandForm');
    const status = document.getElementById('brandStatus');
    if (!api || !form) { if (status) status.textContent = 'run in app'; return; }

    const field = (name) => form.querySelector(`[name="${name}"]`);
    const b = (await api.get()) || {};
    const p = b.product || {};
    const fill = (name, val) => { const el = field(name); if (el) el.value = val || ''; };
    fill('name', p.name); fill('oneLiner', p.oneLiner); fill('description', p.description); fill('url', p.url);
    fill('audience', b.audience); fill('valueProps', b.valueProps); fill('voice', b.voice);
    fill('visual', b.visual); fill('goals', b.goals); fill('guardrails', b.guardrails);
    fill('pillars', (b.pillars || []).join('\n'));

    const ag = b.agents || {};
    const cr = ag.creation || {};
    fill('agent_researcher', (ag.researcher || {}).notes);
    fill('agent_generator', (ag.generator || {}).notes);
    fill('agent_creation', cr.notes);

    document.getElementById('brandSave').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const val = (name) => (field(name)?.value || '').trim();
      const lines = (name) => val(name).split('\n').map(s => s.trim()).filter(Boolean);
      const obj = {
        product: { name: val('name'), oneLiner: val('oneLiner'), description: val('description'), url: val('url') },
        audience: val('audience'), valueProps: val('valueProps'), voice: val('voice'),
        visual: val('visual'),
        pillars: lines('pillars'),
        goals: val('goals'), guardrails: val('guardrails'),
        agents: {
          researcher: { notes: val('agent_researcher') },
          generator: { notes: val('agent_generator') },
          creation: { notes: val('agent_creation') }
        }
      };
      btn.disabled = true;
      await api.set(obj);
      status.textContent = '● saved'; status.classList.add('ok');
      btn.disabled = false;
      setTimeout(() => { status.textContent = ''; status.classList.remove('ok'); }, 2500);
    });
  }

  // ---- cast: manage influencers (refs, TikTok account, timeslots) -----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function mountCast() {
    const api = window.studio && window.studio.influencers;
    const refsApi = window.studio && window.studio.refs;
    const list = document.getElementById('castList');
    const status = document.getElementById('castStatus');
    if (!api || !list) { if (list) list.innerHTML = '<span class="es-sub">Run in the app to manage the cast.</span>'; return; }

    let cast = (await api.get()) || [];
    let channels = [];
    const pz = window.studio && window.studio.postiz;
    if (pz) { const res = await pz.integrations(); channels = (res && res.integrations) || []; }
    const chanErr = !channels.length ? (pz ? 'Save your Postiz key in Settings to map accounts.' : '') : '';

    const accountOptions = (sel) => ['<option value="">— pick a TikTok account —</option>']
      .concat(channels.map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}${c.platform ? ` (${esc(c.platform)})` : ''}</option>`))
      .join('');

    function card(inf, i) {
      const slots = (inf.timeslots || []).map(t =>
        `<span class="slot-chip">${esc(t)}<button type="button" class="slot-del" data-i="${i}" data-slot="${esc(t)}" title="Remove">×</button></span>`).join('');
      return `
        <div class="cast-card" data-i="${i}">
          <div class="cast-card-head">
            <input class="field cast-name" data-i="${i}" value="${esc(inf.name)}" placeholder="Influencer name" />
            <label class="poll-switch-wrap"><span class="mini">enabled</span>
              <button type="button" class="poll-switch ${inf.enabled !== false ? 'on' : ''}" data-enable="${i}"></button></label>
            <button type="button" class="btn sm cast-remove" data-remove="${i}">Remove</button>
          </div>
          <div class="fieldrow"><label>TikTok account<small>${esc(chanErr)}</small></label>
            <select class="field" data-account="${i}">${accountOptions(inf.postizIntegrationId)}</select></div>
          <div class="fieldrow"><label>Content profile<small>ugc = photo slideshows with a character · graphic = designed text cards</small></label>
            <select class="field" data-profile="${i}">
              <option value="ugc"${inf.profile !== 'graphic' ? ' selected' : ''}>UGC (photos + character)</option>
              <option value="graphic"${inf.profile === 'graphic' ? ' selected' : ''}>Graphic (designed cards)</option>
            </select></div>
          ${inf.profile === 'graphic' ? `
          <div class="fieldrow"><label>Design system<small>free text — fed to the image model on every slide</small></label>
            <div class="design-grid">
              <input class="field" data-design="palette" data-i="${i}" value="${esc((inf.design || {}).palette || '')}" placeholder="palette — e.g. dark navy bg, yellow accent, white text" />
              <input class="field" data-design="fontStyle" data-i="${i}" value="${esc((inf.design || {}).fontStyle || '')}" placeholder="typography — e.g. bold condensed sans, all lowercase" />
              <input class="field" data-design="style" data-i="${i}" value="${esc((inf.design || {}).style || '')}" placeholder="style — e.g. minimal cards, big numbers, thin dividers" />
              <input class="field" data-design="voice" data-i="${i}" value="${esc((inf.design || {}).voice || '')}" placeholder="voice — e.g. authoritative, listy" />
            </div></div>` : ''}
          <div class="fieldrow"><label>Daily post times<small>posts fill these slots across days</small></label>
            <div class="slots">${slots || '<span class="es-sub">No slots yet.</span>'}
              <span class="slot-add"><input type="time" class="field slot-input" data-i="${i}" value="12:00" />
              <button type="button" class="btn sm" data-addslot="${i}">+ Add</button></span></div></div>
          <div class="fieldrow"><label>${inf.profile === 'graphic' ? 'Brand assets (optional)<small>example cards / textures — seed the design of slide 1</small>' : 'Reference images<small>up to 14 — kept consistent across this character’s slides</small>'}</label>
            <div class="ref-uploader">
              <div class="ref-grid" data-refgrid="${esc(inf.id)}"></div>
              <label class="btn sm ref-add">+ Add images<input type="file" data-refinput="${esc(inf.id)}" accept="image/*" multiple hidden /></label>
            </div></div>
        </div>`;
    }

    function render() {
      list.innerHTML = cast.length ? cast.map(card).join('') : '<span class="es-sub">No influencers yet — add one below.</span>';
      cast.forEach(inf => renderRefsFor(inf.id));
    }

    async function renderRefsFor(id) {
      if (!refsApi) return;
      const grid = list.querySelector(`[data-refgrid="${CSS.escape(id)}"]`);
      if (!grid) return;
      const items = await refsApi.list(id);
      grid.innerHTML = items.length
        ? items.map(r => `<div class="ref-thumb"><img src="${r.dataUrl}" alt="" /><button class="ref-del" data-refdel="${esc(id)}" data-file="${esc(r.file)}" title="Remove">×</button></div>`).join('')
        : '<span class="es-sub">No reference images yet.</span>';
    }

    // structural interactions → mutate cast + re-render
    list.addEventListener('click', async (e) => {
      const en = e.target.closest('[data-enable]');
      if (en) { const i = +en.dataset.enable; cast[i].enabled = !(cast[i].enabled !== false); render(); return; }
      const rm = e.target.closest('[data-remove]');
      if (rm) { cast.splice(+rm.dataset.remove, 1); render(); return; }
      const add = e.target.closest('[data-addslot]');
      if (add) {
        const i = +add.dataset.addslot;
        const inp = list.querySelector(`.slot-input[data-i="${i}"]`);
        const t = inp && inp.value;
        if (t && !cast[i].timeslots.includes(t)) { cast[i].timeslots = [...cast[i].timeslots, t].sort(); render(); }
        return;
      }
      const ds = e.target.closest('[data-slot]');
      if (ds) { const i = +ds.dataset.i; cast[i].timeslots = cast[i].timeslots.filter(t => t !== ds.dataset.slot); render(); return; }
      const del = e.target.closest('[data-refdel]');
      if (del && refsApi) { await refsApi.remove(del.dataset.refdel, del.dataset.file); renderRefsFor(del.dataset.refdel); return; }
    });
    // text/select edits → sync into cast (no re-render, keep focus)
    list.addEventListener('input', (e) => {
      const n = e.target.closest('[data-i].cast-name'); if (n) { cast[+n.dataset.i].name = n.value; return; }
      const dz = e.target.closest('[data-design]');
      if (dz) { const inf = cast[+dz.dataset.i]; inf.design = inf.design || {}; inf.design[dz.dataset.design] = dz.value; }
    });
    list.addEventListener('change', async (e) => {
      const acc = e.target.closest('[data-account]'); if (acc) { cast[+acc.dataset.account].postizIntegrationId = acc.value; return; }
      const prof = e.target.closest('[data-profile]');
      if (prof) { cast[+prof.dataset.profile].profile = prof.value; render(); return; }
      const ri = e.target.closest('[data-refinput]');
      if (ri && refsApi) {
        const id = ri.dataset.refinput;
        for (const f of ri.files) {
          const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
          await refsApi.add(id, dataUrl);
        }
        ri.value = ''; renderRefsFor(id);
      }
    });

    document.getElementById('castAdd').onclick = () => {
      cast.push({ id: 'inf-' + Math.random().toString(36).slice(2, 8), name: '', postizIntegrationId: '', timeslots: ['09:00', '13:00', '18:00'], enabled: true });
      render();
    };
    document.getElementById('castSave').onclick = async () => {
      status.textContent = 'saving…'; status.classList.remove('ok');
      cast = await api.save(cast);
      render();
      status.textContent = '● saved'; status.classList.add('ok');
      setTimeout(() => { status.textContent = ''; status.classList.remove('ok'); }, 2500);
    };

    render();
  }

  // ---- agents tab: wire the per-agent polling switches ----------------------
  // Incrementally reconcile the feed: prepend only genuinely-new entries so
  // existing rows aren't recreated (no whole-list flash on idle refreshes).
  function updateFeed(fl) {
    const log = STATE.log;
    if (log.length === 0) {
      if (!fl.querySelector('.feed-empty')) fl.innerHTML = window.UI.feedItems(log);
      return;
    }
    if (fl.querySelector('.feed-empty')) fl.innerHTML = '';
    const first = fl.firstElementChild;
    const topId = first ? first.getAttribute('data-id') : null;
    const fresh = [];
    for (const l of log) { if (l.id === topId) break; fresh.push(l); }
    if (!fresh.length) return;
    fl.insertAdjacentHTML('afterbegin', fresh.map(window.UI.feedItem).join(''));
    while (fl.children.length > 80) fl.removeChild(fl.lastElementChild);
  }

  // ---- live updates ---------------------------------------------------------
  function onData() {
    const fl = document.getElementById('drawerFeed');
    if (fl) updateFeed(fl);
  }


  // ---- interactions ---------------------------------------------------------
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { current = tab.dataset.tab; render(); return; }
    if (e.target.closest('#actToggle')) {
      const d = document.getElementById('drawer');
      if (d) { d.classList.toggle('open'); const fl = document.getElementById('drawerFeed'); if (fl) updateFeed(fl); }
      return;
    }
    if (e.target.closest('#drawerClose')) {
      const d = document.getElementById('drawer');
      if (d) d.classList.remove('open');
    }
  });


  // ---- agent worker feed ----------------------------------------------------
  function setupWorkerFeed() {
    const w = window.studio && window.studio.worker;
    if (!w) return;
    w.onLog((payload) => {
      const line = typeof payload === 'string' ? payload : payload.line;
      const agent = (payload && payload.agent) || 'generator';
      trackActivity(agent, line);
      const last = STATE.log[0];
      if (last && last.msg === line && last.agent === agent) return; // dedupe repeats
      STATE.log.unshift({
        id: 'w' + Date.now() + Math.random(),
        agent, tool: 'worker', msg: line,
        t: new Date().toLocaleTimeString('en-US', { hour12: false })
      });
      if (STATE.log.length > 80) STATE.log.pop();
      emit();
    });
  }

  // ---- pipeline: live per-agent activity from the log stream ----------------
  // Log prefixes are the worker protocol: "→/↻/▶" = started work, "✓" = done,
  // "✗/⚠" = error, "·" = idle heartbeat. Drives the node state + activity line.
  const agentActivity = {}; // id -> { line, kind }
  function classifyLine(line) {
    if (/^(→|↻|▶)/.test(line)) return 'working';
    if (/^✓|^\s+✓/.test(line)) return 'done';
    if (/^(✗|⚠)|error/i.test(line)) return 'error';
    if (/^(·|■)/.test(line)) return 'idle';
    return null; // detail line — keep showing it, don't change state
  }
  function trackActivity(agent, line) {
    const kind = classifyLine(line);
    const cur = agentActivity[agent] || { line: '', kind: 'idle' };
    agentActivity[agent] = { line: kind === 'idle' ? cur.line : line, kind: kind || cur.kind };
    if (current !== 'content') return;
    const node = document.querySelector(`[data-node="${agent}"]`);
    if (!node) return;
    const a = agentActivity[agent];
    node.classList.toggle('working', a.kind === 'working');
    node.classList.toggle('error', a.kind === 'error');
    const act = node.querySelector(`[data-activity="${agent}"]`);
    if (act && a.line) act.textContent = a.line.slice(0, 110);
  }

  // ---- boot -----------------------------------------------------------------
  renderNav();
  render();
  subscribe(onData);
  setupWorkerFeed();
  if (window.studio && window.studio.agents) {
    window.studio.agents.list().then(s => { agentStatusCache = s; updateAgentsUI(); });
    window.studio.agents.onStatus(s => { agentStatusCache = s; updateAgentsUI(); });
  }
  // Board badge counts (light poll)
  if (window.studio && window.studio.pipeline) {
    const tick = () => window.studio.pipeline.counts().then(r => { countsCache = (r && r.counts) || {}; renderNav(); }).catch(() => {});
    tick();
    setInterval(tick, 60000);
  }

})();
