/* studio-client.js — the browser implementation of the `window.studio` bridge.
 * The Electron preload exposes this same interface over IPC; here it's HTTP + WS
 * against the v2 server, so renderer/{app,ui,data}.js run unchanged in a browser.
 */
(function () {
  const api = async (path, opts) => {
    const res = await fetch('/api' + path, opts && {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts)
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || `api ${path} → ${res.status}`);
    return data;
  };

  // ---- WS: log stream + agent status, with auto-reconnect --------------------
  const logSubs = new Set();
  const statusSubs = new Set();
  let backoff = 1000;
  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'log') logSubs.forEach((cb) => cb({ agent: msg.agent, line: msg.line }));
        else if (msg.type === 'agents') statusSubs.forEach((cb) => cb(msg.agents));
      } catch { /* ignore */ }
    };
    ws.onopen = () => { backoff = 1000; };
    ws.onclose = () => setTimeout(connect, backoff = Math.min(backoff * 2, 15000));
  }
  connect();

  window.studio = {
    version: '2.0.0',
    mode: 'server',
    secrets: {
      status: () => api('/secrets/status'),
      set: (name, value) => api('/secrets/set', { name, value })
    },
    config: {
      get: () => api('/config'),
      set: (patch) => api('/config', patch)
    },
    brief: {
      get: () => api('/brief'),
      set: (obj) => api('/brief', obj || {})
    },
    influencers: {
      get: () => api('/influencers'),
      save: (list) => api('/influencers', list)
    },
    postiz: {
      integrations: () => api('/postiz/integrations')
    },
    refs: {
      list: (id) => api(`/refs/${encodeURIComponent(id)}`),
      add: (id, dataUrl) => api(`/refs/${encodeURIComponent(id)}`, { dataUrl }),
      remove: (id, file) => api(`/refs/${encodeURIComponent(id)}/remove`, { file })
    },
    agents: {
      list: () => api('/agents'),
      setEnabled: (id, enabled) => api(`/agents/${encodeURIComponent(id)}/enabled`, { enabled }),
      runOnce: (id) => api(`/agents/${encodeURIComponent(id)}/run-once`, {}),
      onStatus: (cb) => { statusSubs.add(cb); return () => statusSubs.delete(cb); }
    },
    approvals: {
      list: () => api('/approvals'),
      resolve: (issueId, decision) => api(`/approvals/${encodeURIComponent(issueId)}/resolve`, { decision })
    },
    pipeline: {
      counts: () => api('/pipeline/counts'),
      stats: () => api('/pipeline/stats')
    },
    worker: {
      onLog: (cb) => { logSubs.add(cb); return () => logSubs.delete(cb); }
    }
  };
})();
