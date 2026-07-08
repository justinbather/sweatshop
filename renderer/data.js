/* data.js — client-side state: the live worker log stream. */
const STATE = { log: [] };
const listeners = new Set();
function emit() { listeners.forEach(fn => fn(STATE)); }
window.DATA = {
  STATE,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit
};
