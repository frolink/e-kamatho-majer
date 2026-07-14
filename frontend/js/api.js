/**
 * frontend/js/api.js
 * Helper fetch ke /api backend. Semua call frontend ke server lewat sini.
 */

const CONFIG = {
  PI_SANDBOX: true,
  API_BASE: '/api',
  DEMO_MODE: true // set false setelah backend deployed & env terisi
};

async function apiPost(path, body) {
  if (CONFIG.DEMO_MODE) return mockBackend(path, body, 'POST');
  const res = await fetch(CONFIG.API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Backend error: ' + path));
  return data;
}

async function apiGet(path) {
  if (CONFIG.DEMO_MODE) return mockBackend(path, null, 'GET');
  const res = await fetch(CONFIG.API_BASE + path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Backend error: ' + path));
  return data;
}

// ── DEMO MOCK ─────────────────────────────────────────────────────────────────
let demoAppBalance = 0;
let demoPiBalance  = 248.75;

async function mockBackend(path) {
  await new Promise(r => setTimeout(r, 400));
  if (path.startsWith('/auth'))
    return { user: { uid: 'demo-uid-001', username: 'pi_user_demo', piAddress: 'GA...TESTNET...DEMO' } };
  if (path.startsWith('/pi?action=wallet-balance'))
    return { piBalance: demoPiBalance, piAddress: 'GA...TESTNET...DEMO' };
  if (path.startsWith('/wallet?action=balance'))
    return { appBalance: demoAppBalance };
  return {};
}
