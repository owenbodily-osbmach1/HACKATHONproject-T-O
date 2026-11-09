// localStorage that never throws (private mode, blocked storage). Falls back to memory.
const mem = new Map();

export const store = {
  get(k, fallback = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? (mem.has(k) ? mem.get(k) : fallback) : JSON.parse(v);
    } catch {
      return mem.has(k) ? mem.get(k) : fallback;
    }
  },
  set(k, v) {
    mem.set(k, v);
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* memory only */ }
  },
};

// Anonymous per-phone ID. This is how "3 different people" is counted.
export function getClientId() {
  let id = store.get('pulse.clientId');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    store.set('pulse.clientId', id);
  }
  return id;
}
