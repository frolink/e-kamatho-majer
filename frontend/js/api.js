/**
 * frontend/js/api.js
 * Helper fetch ke /api backend. Semua call frontend ke server lewat sini.
 *
 * Pengguna hanya melihat "Dompet Pi" dan "Dompet Rupiah".
 * Semua detail TransFi, offramp, payout ditangani backend.
 */

const CONFIG = {
  PI_SANDBOX: true,
  API_BASE: '/api',
  DEMO_MODE: true, // set false setelah backend deployed & env terisi
};

// Header standar — token Pi ditambahkan saat auth
let _piAccessToken = null;
function setPiToken(token) { _piAccessToken = token; }

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (_piAccessToken) h['X-Pi-Access-Token'] = _piAccessToken;
  return h;
}

async function apiPost(path, body) {
  if (CONFIG.DEMO_MODE) return mockBackend(path, body, 'POST');
  const res = await fetch(CONFIG.API_BASE + path, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Backend error: ${path}`);
  return data;
}

async function apiGet(path) {
  if (CONFIG.DEMO_MODE) return mockBackend(path, null, 'GET');
  const res = await fetch(CONFIG.API_BASE + path, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Backend error: ${path}`);
  return data;
}

// Shorthand per endpoint — frontend tidak perlu tahu path detail
const api = {
  auth:    (accessToken, piAddress) => apiPost('/auth', { accessToken, piAddress }),

  // Dompet Pi
  piApprove:  (paymentId, uid) => apiPost('/pi?action=approve',  { paymentId, uid }),
  piComplete: (paymentId, txid, uid) => apiPost('/pi?action=complete', { paymentId, txid, uid }),
  piBalance:  (uid) => apiGet(`/pi?action=balance&uid=${uid}`),

  // Konversi (Pi → Rupiah) — hanya butuh uid + amountPi
  convertQuote:    (amountPi) => apiGet(`/convert?action=quote&amountPi=${amountPi}`),
  convertInitiate: (uid, amountPi) => apiPost('/convert?action=initiate', { uid, amountPi }),

  // Dompet Rupiah
  walletBalance: (uid) => apiGet(`/wallet?action=balance&uid=${uid}`),
  walletHistory: (uid) => apiGet(`/wallet?action=history&uid=${uid}`),

  // Merchant
  merchantList:     (uid) => apiGet(`/merchant?action=list&uid=${uid}`),
  merchantRegister: (body) => apiPost('/merchant?action=register', body),
  merchantPay:      (uid, merchantId, amountIdr) => apiPost('/merchant?action=payout', { uid, merchantId, amountIdr }),

  // Tarik ke bank (baru di sini KYC diminta)
  withdrawKyc:    (uid) => apiGet(`/withdraw?action=kyc-status&uid=${uid}`),
  withdrawSubmit: (body) => apiPost('/withdraw?action=submit', body),
};

// ── DEMO MOCK ──────────────────────────────────────────────────────────────
let _demoPi  = 248.75;
let _demoIdr = 0;

async function mockBackend(path, body) {
  await new Promise(r => setTimeout(r, 400 + Math.random() * 200));

  if (path.startsWith('/auth'))
    return { user: { uid: 'demo-uid-001', username: 'pi_user_demo', piAddress: 'GA...DEMO' } };

  if (path.startsWith('/pi?action=balance'))
    return { piBalance: _demoPi, piAddress: 'GA...DEMO' };

  if (path.startsWith('/pi?action=complete')) {
    _demoPi += Number(body?.amount || 10);
    return { ok: true, amountPi: body?.amount || 10, piBalance: _demoPi };
  }

  if (path.startsWith('/convert?action=quote'))
    return { receiveFiatAmount: Number(new URLSearchParams(path.split('?')[1]).get('amountPi')) * 4200 };

  if (path.startsWith('/convert?action=initiate')) {
    const amt = Number(body?.amountPi || 0);
    _demoPi  -= amt;
    _demoIdr += amt * 4200;
    return { convertId: 'CV-demo', amountPi: amt, status: 'pending_settlement', message: 'Konversi sedang diproses (demo).' };
  }

  if (path.startsWith('/wallet?action=balance'))
    return { piBalance: _demoPi, idrBalance: _demoIdr };

  if (path.startsWith('/wallet?action=history'))
    return { transactions: [] };

  if (path.startsWith('/merchant?action=list'))
    return { merchants: [
      { merchantId: 'global_indomaret', name: 'Indomaret', category: 'Retail', paymentCode: 'virtual_account' },
      { merchantId: 'global_alfamart',  name: 'Alfamart',  category: 'Retail', paymentCode: 'virtual_account' },
      { merchantId: 'global_pln',       name: 'PLN (Token Listrik)', category: 'Utilitas', paymentCode: 'virtual_account' },
    ]};

  if (path.startsWith('/merchant?action=payout')) {
    _demoIdr -= Number(body?.amountIdr || 0);
    return { payoutId: 'PO-demo', amountIdr: body?.amountIdr, idrBalance: _demoIdr };
  }

  if (path.startsWith('/withdraw?action=kyc-status'))
    return { kycStatus: { verifiedForIdr: false } };

  if (path.startsWith('/withdraw?action=submit')) {
    _demoIdr -= Number(body?.amountIdr || 0);
    return { withdrawalId: 'WD-demo', amountIdr: body?.amountIdr, idrBalance: _demoIdr, message: 'Penarikan diproses (demo).' };
  }

  return {};
}

// Ekspor
window._api = api;
window._setPiToken = setPiToken;
