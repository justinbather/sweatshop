/* app.js — controller: nav, routing, live binding, interactions. */
(function () {
  const { STATE, subscribe, emit } = window.DATA;

  let approvals = [];        // real Needs Approval tickets (from Linear)
  let agentStatusCache = []; // real agent worker status (from main process)

  // ---- pixel icons (rect grids -> crisp SVG) --------------------------------
  const G = {
    studio:    ['00000000','01111110','01000010','01011010','01000010','01111110','00011000','00111100'],
    approvals: ['00000010','00000110','00001100','11011000','01110000','00110000','00000000','00000000'],
    agents:    ['00110011','01111111','00110011','00000000','01100110','11111111','01100110','00000000'],
    logs:      ['11111110','00000000','11111100','00000000','11111110','00000000','11110000','00000000'],
    brand:     ['00011000','00011000','00111100','00111100','01111110','01111110','00111100','00000000'],
    settings:  ['00111100','01111110','11100111','11000011','11000011','11100111','01111110','00111100'],
    report:    ['00000000','00000011','00000011','00011011','00011011','11011011','11011011','00000000']
  };
  function icon(name, size = 16) {
    const g = G[name] || G.studio; const n = g.length; const cell = size / n;
    let r = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < g[y].length; x++)
      if (g[y][x] === '1') r += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}"/>`;
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="currentColor" shape-rendering="crispEdges">${r}</svg>`;
  }

  const TABS = [
    { id: 'studio',    label: 'Floor' },
    { id: 'report',    label: 'Report' },
    { id: 'approvals', label: 'Approvals', badge: () => approvals.length, warn: true },
    { id: 'agents',    label: 'Agents' },
    { id: 'brand',     label: 'Brand' },
    { id: 'cast',      label: 'Cast' },
    { id: 'logs',      label: 'Logs' },
    { id: 'settings',  label: 'Settings' }
  ];

  let current = 'studio';

  // ---- nav ------------------------------------------------------------------
  function renderNav() {
    document.getElementById('nav').innerHTML = TABS.map(t => {
      const b = t.badge ? t.badge() : 0;
      const badge = b ? `<span class="badge ${t.warn ? 'warn' : ''}">${b}</span>` : '';
      return `<li data-tab="${t.id}" class="${t.id === current ? 'active' : ''}">${icon(t.id)}<span>${t.label}</span>${badge}</li>`;
    }).join('');
  }

  // ---- avatar (reuse the office sprites) ------------------------------------
  function drawAvatar(canvas, role) {
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    const { BODY, ROLE } = window.SPRITES; const pal = ROLE[role].palette;
    const s = 2, ox = 9, oy = 4;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    BODY.forEach((row, r) => { for (let c = 0; c < row.length; c++) {
      const col = pal[row[c]]; if (!col || row[c] === '.') continue;
      ctx.fillStyle = col; ctx.fillRect(ox + c * s, oy + r * s, s, s);
    }});
    const prop = ROLE[role].prop, ac = ROLE[role].accent;
    const p = (x, y, w, h) => { ctx.fillStyle = ac; ctx.fillRect(ox + x * s, oy + y * s, w * s, h * s); };
    if (prop === 'headset') { p(2, 2, 8, 1); p(1, 4, 2, 3); p(9, 4, 2, 3); }
    else if (prop === 'beret') { p(1, 0, 10, 2); p(2, -1, 6, 1); }
    else if (prop === 'visor') { p(2, 5, 8, 2); }
    else if (prop === 'glasses') { p(2, 5, 3, 2); p(7, 5, 3, 2); }
  }

  // ---- real agent status → topbar pill + floor chips + agent toggles --------
  function pollLabel(st) {
    if (!st) return '—';
    return st.enabled ? (st.running ? 'polling' : 'starting…') : 'paused';
  }
  function updateAgentsUI() {
    const byId = {};
    agentStatusCache.forEach(a => { byId[a.id] = a; });

    const gen = byId['generator'];
    const genDot = document.getElementById('genDot');
    const genLabel = document.getElementById('genLabel');
    if (genLabel) genLabel.textContent = 'generator · ' + pollLabel(gen);
    if (genDot) genDot.classList.toggle('ok', !!(gen && gen.running));

    document.querySelectorAll('.agent-chip[data-chip]').forEach(el => {
      const st = byId[el.dataset.chip];
      el.classList.toggle('idle', !(st && st.running));
      const stateEl = el.querySelector('.ac-state');
      if (stateEl) stateEl.textContent = pollLabel(st);
    });

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
      case 'studio':    view.innerHTML = window.UI.studio(STATE); mountStudio(); break;
      case 'report':    view.innerHTML = window.UI.report(); mountReport(); break;
      case 'approvals': view.innerHTML = window.UI.approvals(approvals); refreshApprovals(); break;
      case 'agents':    view.innerHTML = window.UI.agentsPage(STATE); mountAvatars(); mountAgents(); break;
      case 'brand':     view.innerHTML = window.UI.brand(); mountBrand(); break;
      case 'cast':      view.innerHTML = window.UI.cast(); mountCast(); break;
      case 'logs':      view.innerHTML = window.UI.logs(STATE); break;
      case 'settings':  view.innerHTML = window.UI.settings(); mountSettings(); break;
    }
    renderNav();
    updateAgentsUI();
  }

  // ---- pipeline graph: SVG edges between the laid-out nodes ------------------
  // Solid = the main flow; dashed = branches; dim dashed = datastore reads/writes.
  // lane 'left'/'right' routes long edges out to a side lane (the feedback loop).
  const PIPE_EDGES = [
    { f: 'clock', t: 'strategist', label: 'schedule' },
    { f: 'strategist', t: 'q_gen', label: 'hooks' },
    { f: 'q_gen', t: 'generator' },
    { f: 'generator', t: 'q_creation', label: 'assigned' },
    { f: 'generator', t: 'bench', label: 'bench', dash: true },
    { f: 'bench', t: 'q_creation', label: 'you approve', dash: true },
    { f: 'q_creation', t: 'creator' },
    { f: 'creator', t: 'q_posting', label: 'post tickets' },
    { f: 'poster', t: 'q_ready', label: 'incomplete set', dash: true },
    { f: 'q_ready', t: 'q_posting', label: 'regen → re-approve', dash: true },
    { f: 'q_posting', t: 'poster' },
    { f: 'poster', t: 'tiktok', label: 'slot time' },
    { f: 'st_store', t: 'strategist', label: 'hooks + perf', dash: true, dim: true },
    { f: 'poster', t: 'st_store', label: 'records post', dash: true, dim: true, lane: 'left' },
    { f: 'st_cast', t: 'creator', label: 'refs · design', dash: true, dim: true },
    { f: 'st_cast', t: 'poster', label: 'accounts · slots', dash: true, dim: true },
    { f: 'creator', t: 'st_outputs', label: 'slides', dash: true, dim: true },
    { f: 'st_outputs', t: 'poster', dash: true, dim: true },
    { f: 'tiktok', t: 'strategist', label: '⟲ Postiz analytics (7d)', dash: true, lane: 'right' }
  ];

  function drawPipeEdges() {
    const graph = document.querySelector('.pipe-graph');
    const svg = document.querySelector('.pipe-edges');
    if (!graph || !svg) return;
    const rc = graph.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${rc.width} ${rc.height}`);
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - rc.left, t: r.top - rc.top, r: r.right - rc.left, b: r.bottom - rc.top,
               cx: (r.left + r.right) / 2 - rc.left, cy: (r.top + r.bottom) / 2 - rc.top };
    };
    const parts = [
      `<defs>
        <marker id="pArr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0.5 L7.5,4 L0,7.5 Z" fill="var(--text-faint)"/>
        </marker>
      </defs>`
    ];
    for (const e of PIPE_EDGES) {
      const fe = graph.querySelector(`[data-g="${e.f}"]`);
      const te = graph.querySelector(`[data-g="${e.t}"]`);
      if (!fe || !te) continue;
      const A = rel(fe), B = rel(te);
      let d, lx, ly;
      if (e.lane === 'right') {
        const X = Math.max(A.r, B.r) + 56;
        d = `M ${A.r} ${A.cy} C ${X} ${A.cy}, ${X} ${B.cy}, ${B.r + 2} ${B.cy}`;
        lx = X + 4; ly = (A.cy + B.cy) / 2;
      } else if (e.lane === 'left') {
        const X = Math.min(A.l, B.l) - 44;
        d = `M ${A.l} ${A.cy} C ${X} ${A.cy}, ${X} ${B.cy}, ${B.l - 2} ${B.cy}`;
        lx = X - 4; ly = (A.cy + B.cy) / 2;
      } else if (B.t >= A.b - 6 && Math.abs(B.cx - A.cx) < 60) {
        // straight down the spine
        const g = Math.max(12, (B.t - A.b) / 2);
        d = `M ${A.cx} ${A.b} C ${A.cx} ${A.b + g}, ${B.cx} ${B.t - g}, ${B.cx} ${B.t - 2}`;
        lx = A.cx + 8; ly = (A.b + B.t) / 2;
      } else if (B.t > A.b) {
        // down + across (e.g. Cast → Poster)
        const ex = B.cx > A.cx ? B.l - 2 : B.r + 2;
        d = `M ${A.cx} ${A.b} C ${A.cx} ${A.b + 36}, ${ex + (B.cx > A.cx ? -36 : 36)} ${B.cy}, ${ex} ${B.cy}`;
        lx = A.cx + (B.cx > A.cx ? 14 : -14); ly = (A.b + B.cy) / 2;
      } else {
        // lateral
        const sx = B.cx > A.cx ? A.r : A.l;
        const ex = B.cx > A.cx ? B.l - 2 : B.r + 2;
        const mx = (sx + ex) / 2;
        d = `M ${sx} ${A.cy} C ${mx} ${A.cy}, ${mx} ${B.cy}, ${ex} ${B.cy}`;
        lx = mx; ly = (A.cy + B.cy) / 2 - 5;
      }
      const cls = `pe${e.dash ? ' dash' : ''}${e.dim ? ' dim' : ''}`;
      parts.push(`<path class="${cls}" d="${d}" marker-end="url(#pArr)"/>`);
      if (e.label) parts.push(`<text class="pe-label${e.dim ? ' dim' : ''}" x="${lx}" y="${ly}" text-anchor="${e.lane === 'left' ? 'end' : e.lane === 'right' ? 'start' : 'middle'}">${e.label}</text>`);
    }
    svg.innerHTML = parts.join('');
  }
  let pipeResizeBound = false;

  let pipeTimer = null;
  async function refreshPipeline() {
    const p = window.studio && window.studio.pipeline;
    if (!p || current !== 'studio') return;
    const [countsRes, stats] = await Promise.all([p.counts(), p.stats()]);
    if (current !== 'studio') return;
    const counts = (countsRes && countsRes.counts) || {};
    document.querySelectorAll('[data-count]').forEach(el => {
      el.textContent = counts[el.dataset.count] ?? 0;
      el.classList.toggle('has', (counts[el.dataset.count] || 0) > 0);
    });
    const clock = document.getElementById('clockTimes');
    if (clock) clock.textContent = (stats.autopilotTimes.length ? stats.autopilotTimes.join(' · ') : 'no run times set (Settings → Autopilot)')
      + (stats.lastRun ? ` — last run ${new Date(stats.lastRun).toLocaleString()}` : ' — never run');
    const model = document.getElementById('pipeModel');
    if (model) model.textContent = stats.imageModel;
    const store = document.getElementById('storeStats');
    if (store) store.textContent = `${stats.hooks} hooks · ${stats.posts} posts · ${stats.metricSamples} metric samples`;
    const cast = document.getElementById('castStats');
    if (cast) cast.textContent = stats.influencers.length ? stats.influencers.join(', ') : 'no influencers enabled';
  }

  function mountStudio() {
    // controls: ▶ run-now + auto-poll switches on the agent nodes
    const flow = document.querySelector('.pipe-flow');
    if (flow) {
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
    // show last-known activity immediately
    Object.keys(agentActivity).forEach(id => {
      const a = agentActivity[id];
      const act = document.querySelector(`[data-activity="${id}"]`);
      if (act && a.line) act.textContent = a.line.slice(0, 110);
      const node = document.querySelector(`[data-node="${id}"]`);
      if (node) { node.classList.toggle('working', a.kind === 'working'); node.classList.toggle('error', a.kind === 'error'); }
    });
    refreshPipeline().then(drawPipeEdges);
    if (pipeTimer) clearInterval(pipeTimer);
    pipeTimer = setInterval(() => refreshPipeline().then(drawPipeEdges), 30000);

    // edges depend on rendered positions: draw now, after fonts settle, on resize
    drawPipeEdges();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawPipeEdges);
    setTimeout(drawPipeEdges, 350);
    if (!pipeResizeBound) {
      pipeResizeBound = true;
      let t = null;
      window.addEventListener('resize', () => {
        if (current !== 'studio') return;
        clearTimeout(t); t = setTimeout(drawPipeEdges, 120);
      });
    }
  }
  function mountAvatars() {
    document.querySelectorAll('canvas[data-avatar]').forEach(cv => drawAvatar(cv, cv.dataset.avatar));
  }

  // ---- settings: persist keys to the shared secret store --------------------
  async function mountSettings() {
    const api = window.studio && window.studio.secrets;
    if (!api) {
      document.querySelectorAll('[data-status]').forEach(el => { el.textContent = 'run in app'; });
      return;
    }
    async function refresh() {
      const status = await api.status();
      document.querySelectorAll('[data-status]').forEach(el => {
        const s = status[el.dataset.status];
        el.textContent = s && s.set ? `● saved ${s.masked}` : 'not set';
        el.classList.toggle('ok', !!(s && s.set));
      });
    }
    await refresh();
    const save = async (name) => {
      const input = document.querySelector(`[data-secret="${name}"]`);
      const value = (input.value || '').trim();
      if (!value) return;
      const btn = document.querySelector(`[data-save-secret="${name}"]`);
      if (btn) btn.disabled = true;
      await api.set(name, value);
      input.value = '';
      await refresh();
      if (btn) btn.disabled = false;
    };
    document.querySelectorAll('[data-save-secret]').forEach(btn =>
      btn.addEventListener('click', () => save(btn.dataset.saveSecret)));
    document.querySelectorAll('[data-secret]').forEach(input =>
      input.addEventListener('keydown', e => { if (e.key === 'Enter') save(input.dataset.secret); }));

    // autopilot run times (non-secret config)
    const cfgApi = window.studio && window.studio.config;
    const apSlots = document.getElementById('autopilotSlots');
    if (cfgApi && apSlots) {
      let times = [];
      try { times = (await cfgApi.get()).autopilotTimes || []; } catch { /* fresh */ }
      const renderTimes = () => {
        apSlots.innerHTML = times.map(t =>
          `<span class="slot-chip">${t}<button type="button" class="slot-del" data-aptime="${t}" title="Remove">×</button></span>`).join('')
          + '<span class="slot-add"><input type="time" class="field slot-input" id="apTimeInput" value="09:00" />'
          + '<button type="button" class="btn sm" id="apTimeAdd">+ Add</button></span>';
      };
      apSlots.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-aptime]');
        if (del) { times = times.filter(t => t !== del.dataset.aptime); await cfgApi.set({ autopilotTimes: times }); renderTimes(); return; }
        if (e.target.closest('#apTimeAdd')) {
          const inp = document.getElementById('apTimeInput');
          const t = inp && inp.value;
          if (t && !times.includes(t)) { times = [...times, t].sort(); await cfgApi.set({ autopilotTimes: times }); renderTimes(); }
        }
      });
      renderTimes();
    }

    // daily report time (non-secret config)
    const cfgR = window.studio && window.studio.config;
    const repTime = document.querySelector('[data-config-time="reportTime"]');
    if (cfgR && repTime) {
      const st = document.querySelector('[data-config-status="reportTime"]');
      cfgR.get().then(c => { if (c.reportTime) repTime.value = c.reportTime; if (st) st.textContent = '● saved'; });
      repTime.addEventListener('change', async () => {
        if (st) st.textContent = 'saving…';
        await cfgR.set({ reportTime: repTime.value });
        if (st) { st.textContent = '● saved'; st.classList.add('ok'); }
      });
    }

    // image-model toggle (non-secret config)
    const cfg = window.studio && window.studio.config;
    const modelSel = document.querySelector('[data-config="imageModel"]');
    if (cfg && modelSel) {
      const statusEl = document.querySelector('[data-config-status="imageModel"]');
      const conf = await cfg.get();
      modelSel.value = conf.imageModel === 'openai' ? 'openai' : 'gemini';
      if (statusEl) statusEl.textContent = '● saved';
      modelSel.addEventListener('change', async () => {
        if (statusEl) statusEl.textContent = 'saving…';
        await cfg.set({ imageModel: modelSel.value });
        if (statusEl) { statusEl.textContent = '● saved'; statusEl.classList.add('ok'); }
      });
    }
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
    const stIcon = (s) => s === 'published' ? '🚀' : s === 'error' ? '⚠️' : '⏳';
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
  async function mountReport() {
    const api = window.studio && window.studio.report;
    const root = document.getElementById('reportRoot');
    if (!api || !root) return;
    const meta = document.getElementById('repMeta');
    const status = document.getElementById('repStatus');
    let cached = null;
    repSection = 'business'; // markup marks Business active on mount
    async function load(r) {
      if (!r) r = await api.get();
      cached = r;
      root.innerHTML = renderReport(r);
      if (meta) meta.textContent = `Last collected: ${r.meta.lastCollected ? new Date(r.meta.lastCollected).toLocaleString() : 'never'} · daily at ${r.meta.reportTime}`;
    }
    await load();
    const tabs = document.getElementById('repTabs');
    if (tabs) tabs.addEventListener('click', (e) => {
      const t = e.target.closest('[data-rep]');
      if (!t || !cached) return;
      repSection = t.dataset.rep;
      tabs.querySelectorAll('.rep-tab').forEach(b => b.classList.toggle('active', b === t));
      root.innerHTML = renderReport(cached);
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
  async function mountAgents() {
    const api = window.studio && window.studio.agents;
    if (!api) return;
    agentStatusCache = await api.list();
    updateAgentsUI();
    document.querySelectorAll('[data-agent-worker] [data-poll-switch]').forEach(sw => {
      sw.addEventListener('click', async () => {
        const id = sw.closest('[data-agent-worker]').dataset.agentWorker;
        const enable = !sw.classList.contains('on');
        agentStatusCache = await api.setEnabled(id, enable);
        updateAgentsUI();
      });
    });
  }

  // ---- approval gate (real Linear data) -------------------------------------
  async function refreshApprovals() {
    const api = window.studio && window.studio.approvals;
    if (!api) return;
    const res = await api.list();
    const err = res && res.error ? res.error : null;
    approvals = Array.isArray(res) ? res : [];
    renderNav();
    if (current === 'approvals') {
      document.getElementById('view').innerHTML = window.UI.approvals(approvals, err);
    }
  }

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
    if (current === 'studio') {
      const fl = document.getElementById('feedList');
      if (fl) updateFeed(fl);
    } else if (current === 'logs') {
      render();
    }
  }

  // ---- interactions ---------------------------------------------------------
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { current = tab.dataset.tab; render(); return; }

    const act = e.target.closest('[data-act]');
    if (act) {
      const api = window.studio && window.studio.approvals;
      if (!api) return;
      const id = act.dataset.id;
      const decision = act.dataset.act; // 'approve' | 'reject'
      act.disabled = true;
      const card = act.closest('[data-approve]');
      if (card) card.classList.add('resolving');
      api.resolve(id, decision).then((r) => {
        if (r && r.error) {
          act.disabled = false;
          if (card) card.classList.remove('resolving');
          alert('Linear error: ' + r.error);
          return;
        }
        refreshApprovals();
      });
      return;
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
    if (current !== 'studio') return;
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
  refreshApprovals();
  setInterval(refreshApprovals, 25000);
})();
