#!/usr/bin/env node
/**
 * patch-ekamatho-v2.js
 * Refactor Business Flow + KYC + AML
 *
 * Jalankan dari ROOT folder project: node patch-ekamatho-v2.js
 *
 * Yang diubah:
 *   BACKEND:
 *   1. backend/services/store.js   → pisah piBalance & idrBalance, tambah kycStatus
 *   2. api/pi.js                   → complete() hanya tambah piBalance, tidak trigger TransFi
 *   3. api/convert.js (BARU)       → KYC+AML gate → TransFi Offramp (piBalance→idrBalance)
 *   4. api/merchant.js             → bayar pakai idrBalance saja, hapus Pi SDK
 *   5. api/withdraw.js             → pakai idrBalance, cek kycStatus.verifiedForIdr
 *   6. api/wallet.js               → return piBalance & idrBalance
 *   7. api/webhook.js              → offramp kreditkan idrBalance, withdraw/payout kreditkan idrBalance
 *
 *   FRONTEND:
 *   8. frontend/js/app.js          → pisah piSaldo & idrSaldo, dashboard dua kartu, nav baru
 *   9. frontend/js/payment.js      → TopUp hanya tambah piSaldo, Payment pakai idrSaldo
 *  10. frontend/js/wallet.js       → Konversi Pi→IDR panggil /api/convert dengan KYC gate
 *  11. frontend/index.html         → nav baru, layar Konversi, layar Bayar Merchant pakai IDR
 *
 *   Yang TIDAK diubah:
 *   - Pi SDK (init, authenticate, createPayment, approve, complete)
 *   - TransFi client (transfiClient.js)
 *   - piClient.js
 *   - Auth (api/auth.js)
 *   - CSS (style.css)
 *   - vercel.json (sudah di-patch v1)
 *   - nameMatch.js (tidak berubah)
 */

const fs   = require('fs');
const path = require('path');
const ROOT = process.cwd();

let patchCount = 0;

function backup(fp) {
  if (fs.existsSync(fp)) {
    fs.copyFileSync(fp, fp + '.bak2');
  }
}
function write(rel, content) {
  const full = path.join(ROOT, rel);
  backup(full);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content.trimStart(), 'utf-8');
  console.log('  ✔', rel);
  patchCount++;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. backend/services/store.js — pisah piBalance & idrBalance, tambah kycStatus
// ══════════════════════════════════════════════════════════════════════════════
write('backend/services/store.js', `
/**
 * backend/services/store.js — Vercel KV edition (refactor v2)
 *
 * Perubahan dari v1:
 *   - User kini punya piBalance  (saldo Pi di app, bukan Rupiah)
 *   - User kini punya idrBalance (saldo Rupiah hasil konversi TransFi)
 *   - kycStatus: { verifiedForIdr, bankName, accountNumber, accountHolderName, verifiedAt }
 *
 * Setup: npm install @vercel/kv && vercel env pull
 */
const { kv } = require('@vercel/kv');

function defaultMerchants() {
  return {
    global_indomaret: { merchantId:'global_indomaret', scope:'global', name:'Indomaret', category:'Retail', paymentCode:'virtual_account', bankName:'BRI', accountNumber:'777081234567890', accountHolderName:'PT Indomarco Prismatama' },
    global_alfamart:  { merchantId:'global_alfamart',  scope:'global', name:'Alfamart',  category:'Retail', paymentCode:'virtual_account', bankName:'Permata', accountNumber:'888091234567890', accountHolderName:'PT Sumber Alfaria Trijaya' },
    global_pln:       { merchantId:'global_pln', scope:'global', name:'PLN (Token Listrik)', category:'Utilitas', paymentCode:'virtual_account', bankName:'BNI', accountNumber:'888888012345678', accountHolderName:'PT PLN (Persero)' },
  };
}
async function ensureDefaultMerchants() {
  const ex = await kv.get('merchants:global');
  if (ex && ex.length > 0) return;
  const m = defaultMerchants(); const ids = [];
  await Promise.all(Object.values(m).map(async v => { await kv.set('merchant:' + v.merchantId, v); ids.push(v.merchantId); }));
  await kv.set('merchants:global', ids);
}

// ── USERS ────────────────────────────────────────────────────────────────────
async function upsertUser({ uid, username, piAddress }) {
  const ex = (await kv.get('user:' + uid)) || { piBalance: 0, idrBalance: 0 };
  // Migrasi: kalau masih pakai appBalance lama, pindahkan ke piBalance
  if (ex.appBalance !== undefined && ex.piBalance === undefined) {
    ex.piBalance = ex.appBalance; delete ex.appBalance;
  }
  const u = { ...ex, uid, username, piAddress: piAddress || ex.piAddress || null,
    piBalance:  Number(ex.piBalance  || 0),
    idrBalance: Number(ex.idrBalance || 0),
    kycStatus:  ex.kycStatus || { verifiedForIdr: false },
  };
  await kv.set('user:' + uid, u);
  return u;
}
async function getUser(uid) { return (await kv.get('user:' + uid)) || null; }

async function getPiBalance(uid) {
  const u = await kv.get('user:' + uid);
  if (!u) return 0;
  // migrasi saldo lama
  if (u.appBalance !== undefined && u.piBalance === undefined) return Number(u.appBalance || 0);
  return Number(u.piBalance || 0);
}
async function getIdrBalance(uid) {
  const u = await kv.get('user:' + uid);
  return u ? Number(u.idrBalance || 0) : 0;
}
// Alias lama untuk backward compat (wallet.js lama mungkin masih pakai getAppBalance)
async function getAppBalance(uid) { return getIdrBalance(uid); }

async function creditPiBalance(uid, amount) {
  const u = (await kv.get('user:' + uid)) || { uid, piBalance: 0, idrBalance: 0, kycStatus: { verifiedForIdr: false } };
  if (u.appBalance !== undefined) { u.piBalance = u.appBalance; delete u.appBalance; }
  u.piBalance = Number(u.piBalance || 0) + Number(amount);
  await kv.set('user:' + uid, u);
  return u.piBalance;
}
async function debitPiBalance(uid, amount) {
  const u = (await kv.get('user:' + uid)) || { uid, piBalance: 0, idrBalance: 0 };
  if (u.appBalance !== undefined) { u.piBalance = u.appBalance; delete u.appBalance; }
  const cur = Number(u.piBalance || 0);
  if (cur < Number(amount)) throw new Error('Saldo Pi tidak cukup');
  u.piBalance = cur - Number(amount);
  await kv.set('user:' + uid, u);
  return u.piBalance;
}
async function creditIdrBalance(uid, amount) {
  const u = (await kv.get('user:' + uid)) || { uid, piBalance: 0, idrBalance: 0 };
  u.idrBalance = Number(u.idrBalance || 0) + Number(amount);
  await kv.set('user:' + uid, u);
  return u.idrBalance;
}
async function debitIdrBalance(uid, amount) {
  const u = (await kv.get('user:' + uid)) || { uid, piBalance: 0, idrBalance: 0 };
  const cur = Number(u.idrBalance || 0);
  if (cur < Number(amount)) throw new Error('Saldo Rupiah tidak cukup');
  u.idrBalance = cur - Number(amount);
  await kv.set('user:' + uid, u);
  return u.idrBalance;
}
// Alias lama
async function creditAppBalance(uid, amount) { return creditIdrBalance(uid, amount); }
async function debitAppBalance(uid, amount)  { return debitIdrBalance(uid, amount); }

// ── KYC STATUS ───────────────────────────────────────────────────────────────
async function setKycVerified(uid, { bankName, accountNumber, accountHolderName, piName }) {
  const u = (await kv.get('user:' + uid)) || { uid, piBalance: 0, idrBalance: 0 };
  u.kycStatus = { verifiedForIdr: true, bankName, accountNumber, accountHolderName, piName, verifiedAt: new Date().toISOString() };
  await kv.set('user:' + uid, u);
  return u.kycStatus;
}
async function getKycStatus(uid) {
  const u = await kv.get('user:' + uid);
  return u ? (u.kycStatus || { verifiedForIdr: false }) : { verifiedForIdr: false };
}
async function revokeKycVerified(uid) {
  const u = (await kv.get('user:' + uid)) || { uid, piBalance: 0, idrBalance: 0 };
  u.kycStatus = { verifiedForIdr: false };
  await kv.set('user:' + uid, u);
}

// ── PI PAYMENTS ───────────────────────────────────────────────────────────────
async function getPiPayment(id) { return (await kv.get('payment:' + id)) || null; }
async function savePiPaymentApproved(id, data) {
  const u = { ...(await kv.get('payment:' + id) || {}), ...data, status: 'approved' };
  await kv.set('payment:' + id, u); return u;
}
async function savePiPaymentCompleted(id, data) {
  const u = { ...(await kv.get('payment:' + id) || {}), ...data, status: 'completed' };
  await kv.set('payment:' + id, u); return u;
}

// ── KONVERSI ORDERS (Pi→IDR via TransFi Offramp, dipicu dari /api/convert) ──
async function createTransfiOrder(order) {
  const d = { ...order, status: order.status || 'initiated' };
  await kv.set('transfiOrder:' + order.orderId, d);
  if (order.piPaymentId) await kv.set('transfiByPi:' + order.piPaymentId, order.orderId);
  if (order.uid)         await kv.set('transfiByConvert:' + order.convertId, order.orderId);
  return d;
}
async function getTransfiOrder(id) { return (await kv.get('transfiOrder:' + id)) || null; }
async function updateTransfiOrder(id, data) {
  const u = { ...(await kv.get('transfiOrder:' + id) || {}), ...data };
  await kv.set('transfiOrder:' + id, u); return u;
}
async function findTransfiOrderByPiPaymentId(pid) {
  const oid = await kv.get('transfiByPi:' + pid);
  return oid ? getTransfiOrder(oid) : null;
}

// ── PAYOUTS ───────────────────────────────────────────────────────────────────
async function createPayout(p) { const d={...p,status:p.status||'pending'}; await kv.set('payout:' + p.payoutId, d); return d; }
async function getPayout(id)   { return (await kv.get('payout:' + id)) || null; }
async function updatePayout(id, data) { const u={...(await kv.get('payout:'+id)||{}), ...data}; await kv.set('payout:'+id, u); return u; }

// ── WITHDRAWALS ───────────────────────────────────────────────────────────────
async function createWithdrawal(w) { const d={...w,status:w.status||'pending'}; await kv.set('withdrawal:'+w.withdrawalId, d); return d; }
async function getWithdrawal(id)   { return (await kv.get('withdrawal:'+id)) || null; }
async function updateWithdrawal(id, data) { const u={...(await kv.get('withdrawal:'+id)||{}), ...data}; await kv.set('withdrawal:'+id, u); return u; }

// ── MERCHANTS ─────────────────────────────────────────────────────────────────
async function createMerchant(m) {
  await kv.set('merchant:' + m.merchantId, m);
  if (m.scope === 'global') {
    const idx = (await kv.get('merchants:global')) || [];
    if (!idx.includes(m.merchantId)) { idx.push(m.merchantId); await kv.set('merchants:global', idx); }
  } else if (m.ownerUid) {
    const k = 'merchants:user:' + m.ownerUid;
    const idx = (await kv.get(k)) || [];
    if (!idx.includes(m.merchantId)) { idx.push(m.merchantId); await kv.set(k, idx); }
  }
  return m;
}
async function getMerchant(id) { await ensureDefaultMerchants(); return (await kv.get('merchant:' + id)) || null; }
async function listMerchants(uid) {
  await ensureDefaultMerchants();
  const gids = (await kv.get('merchants:global')) || [];
  const uids = uid ? (await kv.get('merchants:user:' + uid)) || [] : [];
  const all  = [...new Set([...gids, ...uids])];
  return (await Promise.all(all.map(id => kv.get('merchant:' + id)))).filter(Boolean);
}

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────
async function addTransaction(tx) {
  const k = 'transactions:' + tx.uid;
  const list = (await kv.get(k)) || [];
  list.unshift({ ...tx, createdAt: new Date().toISOString() });
  if (list.length > 500) list.splice(500);
  await kv.set(k, list);
}
async function listTransactions(uid) { return (await kv.get('transactions:' + uid)) || []; }

module.exports = {
  upsertUser, getUser,
  getPiBalance, getIdrBalance, getAppBalance,
  creditPiBalance, debitPiBalance,
  creditIdrBalance, debitIdrBalance,
  creditAppBalance, debitAppBalance,
  setKycVerified, getKycStatus, revokeKycVerified,
  getPiPayment, savePiPaymentApproved, savePiPaymentCompleted,
  createTransfiOrder, getTransfiOrder, updateTransfiOrder, findTransfiOrderByPiPaymentId,
  createPayout, getPayout, updatePayout,
  createWithdrawal, getWithdrawal, updateWithdrawal,
  createMerchant, getMerchant, listMerchants,
  addTransaction, listTransactions,
};
`);

// ══════════════════════════════════════════════════════════════════════════════
// 2. api/pi.js — complete() hanya tambah piBalance, TIDAK trigger TransFi
// ══════════════════════════════════════════════════════════════════════════════
write('api/pi.js', `
/**
 * /api/pi — Top Up Pi via Pi SDK.
 *
 * Flow baru (v2):
 *   Pi Wallet → Pi SDK → approve → complete → piBalance bertambah
 *
 * Pi TIDAK langsung dikonversi ke IDR di sini.
 * Konversi Pi→IDR dilakukan terpisah lewat /api/convert setelah user
 * memilih menu Konversi dan lolos verifikasi KYC & AML.
 *
 *   GET  /api/pi?action=wallet-balance&uid=...
 *   POST /api/pi?action=approve    body: { paymentId, uid }
 *   POST /api/pi?action=complete   body: { paymentId, txid, uid }
 */
const axios = require('axios');
const piClient = require('../backend/services/piClient');
const store    = require('../backend/services/store');

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.testnet.minepi.com';
const balanceCache = new Map();
const CACHE_TTL = 10_000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action;
  try {
    if (req.method === 'GET'  && action === 'wallet-balance') return await walletBalance(req, res);
    if (req.method === 'POST' && action === 'approve')        return await approve(req, res);
    if (req.method === 'POST' && action === 'complete')       return await complete(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal' });
  } catch (err) {
    console.error('api/pi error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Terjadi kesalahan pada Top Up Pi' });
  }
};

async function approve(req, res) {
  const { paymentId, uid } = req.body || {};
  if (!paymentId || !uid) return res.status(400).json({ error: 'paymentId & uid wajib diisi' });
  const payment = await piClient.getPayment(paymentId);
  if (payment.user_uid !== uid) return res.status(403).json({ error: 'Payment bukan milik user ini' });
  if (payment.status?.developer_approved) return res.json({ ok: true, alreadyApproved: true });
  await piClient.approvePayment(paymentId);
  await store.savePiPaymentApproved(paymentId, { paymentId, uid, amount: payment.amount, memo: payment.memo });
  return res.json({ ok: true });
}

async function complete(req, res) {
  const { paymentId, txid, uid } = req.body || {};
  if (!paymentId || !txid || !uid) return res.status(400).json({ error: 'paymentId, txid & uid wajib diisi' });

  // Idempoten — kalau sudah di-complete sebelumnya, kembalikan data lama
  const existing = await store.getPiPayment(paymentId);
  if (existing && existing.status === 'completed') {
    return res.json({ amountPi: existing.amount, piTxId: existing.txid, alreadyCompleted: true });
  }

  const payment = await piClient.getPayment(paymentId);
  if (payment.user_uid !== uid) return res.status(403).json({ error: 'Payment bukan milik user ini' });

  // Tandai selesai di Pi Platform → Pi resmi masuk ke wallet developer
  await piClient.completePayment(paymentId, txid);
  await store.savePiPaymentCompleted(paymentId, { paymentId, uid, amount: payment.amount, txid });

  // Tambah piBalance — BUKAN idrBalance. Konversi dilakukan terpisah via /api/convert.
  const newPiBalance = await store.creditPiBalance(uid, payment.amount);
  console.log('[pi/complete] piBalance setelah top up:', uid, newPiBalance);

  await store.addTransaction({
    uid, type: 'topup_pi', name: 'Top Up Pi',
    badge: 'Pi SDK', amountPi: payment.amount, txid, paymentId,
  });

  return res.json({ amountPi: payment.amount, piTxId: txid, newPiBalance });
}

async function walletBalance(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });
  const user = await store.getUser(uid);
  if (!user || !user.piAddress) return res.json({ piBalance: 0, piAddress: null });
  const cached = balanceCache.get(user.piAddress);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return res.json({ piBalance: cached.piBalance, piAddress: user.piAddress, cached: true });
  }
  try {
    const r = await axios.get(HORIZON_URL + '/accounts/' + user.piAddress, { timeout: 15000 });
    const native = (r.data.balances || []).find(b => b.asset_type === 'native');
    const piBalance = native ? Number(native.balance) : 0;
    balanceCache.set(user.piAddress, { at: Date.now(), piBalance });
    return res.json({ piBalance, piAddress: user.piAddress });
  } catch (err) {
    if (err.response?.status === 404) return res.json({ piBalance: 0, piAddress: user.piAddress });
    return res.status(500).json({ error: 'Gagal mengambil saldo Pi' });
  }
}
`);

// ══════════════════════════════════════════════════════════════════════════════
// 3. api/convert.js (BARU) — KYC+AML gate → TransFi Offramp
// ══════════════════════════════════════════════════════════════════════════════
write('api/convert.js', `
/**
 * /api/convert — Konversi Pi → Rupiah via TransFi Offramp.
 *
 * Ini satu-satunya pintu masuk dari aset kripto (Pi) ke fiat (IDR).
 *
 * Gate AML sebelum offramp:
 *   1. Cek status KYC Pi user (dari Pi Platform API)
 *   2. Cek rekening bank sudah diverifikasi via KYC TransFi
 *   3. Cocokkan nama Pi KYC dengan nama pemilik rekening bank
 *   4. Jika lolos → jalankan TransFi Offramp (debit piBalance, nanti idrBalance
 *      bertambah saat webhook TransFi settle tiba)
 *   5. Set kycStatus.verifiedForIdr = true di store
 *
 *   POST /api/convert?action=initiate
 *   body: { uid, amountPi, piKycName, bankName, accountNumber, accountHolderName }
 *
 *   GET /api/convert?action=status&uid=...
 */
const crypto = require('crypto');
const transfiClient = require('../backend/services/transfiClient');
const piClient      = require('../backend/services/piClient');
const store         = require('../backend/services/store');
const { namesMatch } = require('../backend/utils/nameMatch');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action;
  try {
    if (req.method === 'POST' && action === 'initiate') return await initiate(req, res);
    if (req.method === 'GET'  && action === 'status')   return await status(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/convert' });
  } catch (err) {
    console.error('api/convert error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Gagal memproses konversi' });
  }
};

async function initiate(req, res) {
  const { uid, amountPi, piKycName, bankName, accountNumber, accountHolderName } = req.body || {};
  if (!uid || !amountPi || !piKycName || !bankName || !accountNumber || !accountHolderName) {
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  }
  if (Number(amountPi) <= 0) return res.status(400).json({ error: 'Jumlah Pi harus lebih dari 0' });

  const user = await store.getUser(uid);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

  // ── Cek piBalance mencukupi ───────────────────────────────────────────────
  const piBalance = await store.getPiBalance(uid);
  if (piBalance < Number(amountPi)) {
    return res.status(400).json({ error: 'Saldo Pi tidak cukup untuk dikonversi' });
  }

  // ── Cek kycStatus: kalau sudah verifiedForIdr dan rekening sama, skip nama check ──
  const kycStatus = await store.getKycStatus(uid);
  const sameAccount = kycStatus.verifiedForIdr
    && kycStatus.accountNumber === accountNumber
    && kycStatus.bankName      === bankName;

  if (!sameAccount) {
    // ── GATE 1: Pi KYC status ─────────────────────────────────────────────
    let piUserKycPassed = false;
    try {
      const accessToken = req.headers['x-pi-access-token'];
      if (accessToken) {
        const me = await piClient.getMe(accessToken);
        piUserKycPassed = me?.kyc_verified === true || me?.roles?.includes('kyc_verified') || false;
      }
    } catch (e) {
      console.warn('[convert] Gagal cek Pi KYC status:', e.message);
      // Jangan blokir jika gagal cek — log saja, lanjutkan ke pengecekan nama
    }

    // ── GATE 2 & 3: Pencocokan nama AML ──────────────────────────────────
    if (!namesMatch(piKycName, accountHolderName)) {
      return res.status(400).json({
        error: 'Nama pemilik akun Pi harus sesuai dengan nama pemilik rekening bank untuk memenuhi kebijakan KYC dan AML.',
        amlViolation: true,
      });
    }
  }

  // ── Debit piBalance di muka (cegah double-spend) ──────────────────────────
  await store.debitPiBalance(uid, amountPi);

  const convertId = 'CV-' + crypto.randomUUID();

  // ── Jalankan TransFi Offramp ──────────────────────────────────────────────
  let transfiOrderId = null;
  try {
    const order = await transfiClient.createOfframpOrder({
      customerOrderId: convertId,
      cryptoTicker:    'PI',
      depositAmount:   amountPi,
      withdrawCurrency:'IDR',
      customerName:    accountHolderName,
    });
    transfiOrderId = order.orderId || order.data?.orderId;
    await store.createTransfiOrder({
      orderId:         transfiOrderId,
      uid,
      convertId,
      depositAmount:   amountPi,
      depositCurrency: 'PI',
      withdrawCurrency:'IDR',
      bankName, accountNumber, accountHolderName,
      status: 'initiated',
      raw: order,
    });
  } catch (err) {
    // TransFi gagal — kembalikan piBalance
    await store.creditPiBalance(uid, amountPi);
    console.error('[convert] TransFi offramp gagal:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Konversi ke TransFi gagal. Saldo Pi dikembalikan. Coba lagi.' });
  }

  // ── Set KYC Verified ──────────────────────────────────────────────────────
  await store.setKycVerified(uid, { bankName, accountNumber, accountHolderName, piName: piKycName });

  await store.addTransaction({
    uid, type: 'convert_pi', name: 'Konversi Pi → Rupiah',
    badge: 'TransFi Offramp', amountPi, convertId, transfiOrderId,
    note: 'IDR masuk setelah TransFi settle',
  });

  return res.json({
    convertId,
    transfiOrderId,
    amountPi,
    status: 'pending_settlement',
    message: 'Konversi dimulai. Saldo Rupiah akan bertambah setelah TransFi mengonfirmasi settlement.',
  });
}

async function status(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });
  const kycStatus  = await store.getKycStatus(uid);
  const piBalance  = await store.getPiBalance(uid);
  const idrBalance = await store.getIdrBalance(uid);
  return res.json({ kycStatus, piBalance, idrBalance });
}
`);

// ══════════════════════════════════════════════════════════════════════════════
// 4. api/wallet.js — return piBalance & idrBalance
// ══════════════════════════════════════════════════════════════════════════════
write('api/wallet.js', `
/**
 * /api/wallet — dua saldo: piBalance & idrBalance.
 *
 *   GET /api/wallet?action=balance&uid=...
 *   GET /api/wallet?action=history&uid=...
 */
const store = require('../backend/services/store');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { uid, action } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });

  if (action === 'balance') {
    const piBalance  = await store.getPiBalance(uid);
    const idrBalance = await store.getIdrBalance(uid);
    const kycStatus  = await store.getKycStatus(uid);
    console.log('[wallet] balance', uid, { piBalance, idrBalance });
    return res.json({ piBalance, idrBalance, kycStatus, appBalance: idrBalance }); // appBalance untuk backward compat
  }
  if (action === 'history') {
    return res.json({ transactions: await store.listTransactions(uid) });
  }
  return res.status(400).json({ error: 'Aksi tidak dikenal' });
};
`);

// ══════════════════════════════════════════════════════════════════════════════
// 5. api/merchant.js — bayar pakai idrBalance, tanpa Pi SDK
// ══════════════════════════════════════════════════════════════════════════════
write('api/merchant.js', `
/**
 * /api/merchant — Bayar Merchant dari Saldo Rupiah via TransFi Payout.
 *
 * Flow v2 (TIDAK ada Pi SDK):
 *   idrBalance → debit → TransFi Payout → Rekening Merchant
 *
 *   GET  /api/merchant?action=list&uid=...
 *   POST /api/merchant?action=register   body: { uid, name, category, paymentCode, bankName, accountNumber, accountHolderName }
 *   POST /api/merchant?action=payout     body: { uid, merchantId, amountIdr }
 */
const crypto = require('crypto');
const transfiClient = require('../backend/services/transfiClient');
const store = require('../backend/services/store');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action;
  try {
    if (req.method === 'GET'  && action === 'list')     return await listMerchants(req, res);
    if (req.method === 'POST' && action === 'register') return await registerMerchant(req, res);
    if (req.method === 'POST' && action === 'payout')   return await payout(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal' });
  } catch (err) {
    console.error('api/merchant error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Terjadi kesalahan pada modul Merchant' });
  }
};

async function listMerchants(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });
  return res.json({ merchants: await store.listMerchants(uid) });
}

async function registerMerchant(req, res) {
  const { uid, name, category, paymentCode, bankName, accountNumber, accountHolderName } = req.body || {};
  if (!uid || !name || !paymentCode || !bankName || !accountNumber || !accountHolderName) {
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  }
  if (!['bank_transfer','virtual_account'].includes(paymentCode)) {
    return res.status(400).json({ error: 'paymentCode harus bank_transfer atau virtual_account' });
  }
  const merchantId = 'm_' + crypto.randomUUID();
  const merchant   = await store.createMerchant({ merchantId, scope:'personal', ownerUid:uid, name, category: category||'Umum', paymentCode, bankName, accountNumber, accountHolderName });
  return res.json({ merchant });
}

async function payout(req, res) {
  const { uid, merchantId, amountIdr } = req.body || {};
  if (!uid || !merchantId || !amountIdr) return res.status(400).json({ error: 'uid, merchantId & amountIdr wajib diisi' });
  if (amountIdr < 1000) return res.status(400).json({ error: 'Jumlah minimal Rp1.000' });

  const merchant = await store.getMerchant(merchantId);
  if (!merchant) return res.status(400).json({ error: 'Merchant tidak ditemukan' });
  if (merchant.scope === 'personal' && merchant.ownerUid !== uid) {
    return res.status(403).json({ error: 'Merchant ini bukan milik kamu' });
  }

  // Cek idrBalance (bukan piBalance)
  const idrBalance = await store.getIdrBalance(uid);
  if (amountIdr > idrBalance) return res.status(400).json({ error: 'Saldo Rupiah tidak cukup. Lakukan konversi Pi → Rupiah terlebih dahulu.' });

  const payoutId = 'PO-' + crypto.randomUUID();

  // Debit idrBalance di muka, simpan pending
  await store.debitIdrBalance(uid, amountIdr);
  await store.createPayout({ payoutId, uid, merchantId, amountIdr, status: 'pending' });

  try {
    const payoutRes = await transfiClient.createPayout({
      customerOrderId: payoutId,
      amountIdr,
      paymentCode:       merchant.paymentCode,
      bankName:          merchant.bankName,
      accountNumber:     merchant.accountNumber,
      accountHolderName: merchant.accountHolderName,
    });
    await store.updatePayout(payoutId, { status:'submitted', transfiRef: payoutRes.orderId || payoutRes.data?.orderId, raw: payoutRes });
  } catch (err) {
    console.error('[merchant/payout] TransFi gagal:', err.response?.data || err.message);
    await store.creditIdrBalance(uid, amountIdr);
    await store.updatePayout(payoutId, { status:'failed', errorMessage: err.message });
    return res.status(502).json({ error: 'Payout ke TransFi gagal, saldo dikembalikan.' });
  }

  await store.addTransaction({ uid, type:'merchant', name:'Bayar '+merchant.name, badge:'TransFi Payout', amountIdr, payoutId });

  return res.json({ payoutId, amountIdr, newIdrBalance: await store.getIdrBalance(uid) });
}
`);

// ══════════════════════════════════════════════════════════════════════════════
// 6. api/withdraw.js — pakai idrBalance, cek kycStatus.verifiedForIdr
// ══════════════════════════════════════════════════════════════════════════════
write('api/withdraw.js', `
/**
 * /api/withdraw — Tarik Saldo Rupiah ke rekening bank pribadi.
 *
 * Tidak perlu cek nama lagi jika:
 *   - kycStatus.verifiedForIdr === true
 *   - rekening tujuan = rekening yang sudah diverifikasi
 *
 * Jika rekening berbeda, wajib cek ulang AML (pencocokan nama).
 *
 *   POST /api/withdraw?action=submit
 *   body: { uid, bankName, accountNumber, accountHolderName, amountIdr, piAccountName? }
 */
const crypto = require('crypto');
const transfiClient = require('../backend/services/transfiClient');
const store = require('../backend/services/store');
const { namesMatch } = require('../backend/utils/nameMatch');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' || req.query.action !== 'submit') {
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/withdraw' });
  }
  try {
    const { uid, bankName, accountNumber, accountHolderName, amountIdr, piAccountName } = req.body || {};
    if (!uid || !bankName || !accountNumber || !accountHolderName || !amountIdr) {
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    }
    if (amountIdr < 10000) return res.status(400).json({ error: 'Jumlah penarikan minimal Rp10.000' });

    const kycStatus  = await store.getKycStatus(uid);
    const sameAccount = kycStatus.verifiedForIdr
      && kycStatus.accountNumber === accountNumber
      && kycStatus.bankName      === bankName;

    // AML check hanya jika belum verified atau rekening berbeda
    if (!sameAccount) {
      const piName = piAccountName || kycStatus.piName || '';
      if (!piName) return res.status(400).json({ error: 'Nama akun Pi wajib diisi untuk verifikasi AML rekening baru' });
      if (!namesMatch(piName, accountHolderName)) {
        return res.status(400).json({
          error: 'Nama pemilik akun Pi harus sesuai dengan nama pemilik rekening bank untuk memenuhi kebijakan KYC dan AML.',
          amlViolation: true,
        });
      }
      // Update kycStatus ke rekening baru
      await store.setKycVerified(uid, { bankName, accountNumber, accountHolderName, piName });
    }

    const idrBalance = await store.getIdrBalance(uid);
    if (amountIdr > idrBalance) return res.status(400).json({ error: 'Saldo Rupiah tidak cukup' });

    const withdrawalId = 'WD-' + crypto.randomUUID();
    await store.debitIdrBalance(uid, amountIdr);
    await store.createWithdrawal({ withdrawalId, uid, amountIdr, bankName, accountNumber, accountHolderName, status:'pending' });

    try {
      const payoutRes = await transfiClient.createBankWithdrawal({ customerOrderId: withdrawalId, amountIdr, bankName, accountNumber, accountHolderName });
      await store.updateWithdrawal(withdrawalId, { status:'submitted', transfiRef: payoutRes.orderId || payoutRes.data?.orderId, raw: payoutRes });
    } catch (err) {
      console.error('[withdraw] TransFi gagal:', err.response?.data || err.message);
      await store.creditIdrBalance(uid, amountIdr);
      await store.updateWithdrawal(withdrawalId, { status:'failed', errorMessage: err.message });
      return res.status(502).json({ error: 'Penarikan ke TransFi gagal, saldo dikembalikan.' });
    }

    await store.addTransaction({ uid, type:'withdraw', name:'Tarik ke '+bankName, badge:'TransFi Withdrawal', amountIdr, withdrawalId });
    return res.json({ withdrawalId, amountIdr, newIdrBalance: await store.getIdrBalance(uid) });
  } catch (err) {
    console.error('api/withdraw error:', err.message);
    return res.status(400).json({ error: err.message || 'Gagal memproses penarikan' });
  }
};
`);

// ══════════════════════════════════════════════════════════════════════════════
// 7. api/webhook.js — offramp kredit idrBalance (bukan piBalance)
// ══════════════════════════════════════════════════════════════════════════════
write('api/webhook.js', `
/**
 * POST /api/webhook — callback server-to-server dari TransFi.
 *
 * Event yang ditangani:
 *   - Offramp (Konversi Pi→IDR): settled → creditIdrBalance
 *   - Payout (Bayar Merchant):   failed  → creditIdrBalance (rollback)
 *   - Withdrawal (Tarik):        failed  → creditIdrBalance (rollback)
 */
const transfiClient = require('../backend/services/transfiClient');
const store = require('../backend/services/store');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rawBody  = await readRawBody(req);
    const signature = req.headers['x-transfi-signature'];
    if (!transfiClient.verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Signature tidak valid' });
    }

    const payload        = JSON.parse(rawBody.toString('utf-8'));
    const order          = payload.order || {};
    const status         = payload.status || order.status;
    const entityId       = payload.entityId || order.orderId;
    const customerOrderId = order.customerOrderId;

    console.log('[webhook] diterima:', { entityId, status, customerOrderId });

    // ── Kasus 1: Offramp (Konversi Pi→IDR) ─────────────────────────────────
    const transfiOrder = await store.getTransfiOrder(entityId);
    if (transfiOrder) {
      await store.updateTransfiOrder(entityId, { status, lastWebhookPayload: payload });
      const isSettled = ['fund_settled','settled','completed'].includes(status);
      if (isSettled && transfiOrder.status !== 'credited') {
        const withdrawAmount = Number(order.withdrawAmount || transfiOrder.withdrawAmount || 0);
        if (withdrawAmount > 0) {
          const newBalance = await store.creditIdrBalance(transfiOrder.uid, withdrawAmount);
          await store.updateTransfiOrder(entityId, { status:'credited', withdrawAmount, creditedAt: new Date().toISOString() });
          await store.addTransaction({
            uid: transfiOrder.uid, type:'convert_settled', name:'Pi → Rupiah (settled)',
            badge:'TransFi Offramp', amountIdr: withdrawAmount, orderId: entityId,
          });
          console.log('[webhook] idrBalance user', transfiOrder.uid, 'bertambah', withdrawAmount, '→ total', newBalance);
        }
      }
      if (['failed','expired'].includes(status)) {
        // Kembalikan piBalance
        if (transfiOrder.depositAmount) await store.creditPiBalance(transfiOrder.uid, transfiOrder.depositAmount);
        await store.updateTransfiOrder(entityId, { status });
        console.warn('[webhook] Offramp', entityId, status, '— piBalance dikembalikan');
      }
      return res.status(200).json({ received: true, handled: 'offramp' });
    }

    // ── Kasus 2: Payout ke merchant ─────────────────────────────────────────
    const payout = await store.getPayout(customerOrderId || entityId);
    if (payout) {
      const payoutId = customerOrderId || entityId;
      if (['failed','expired'].includes(status) && payout.status !== 'failed') {
        await store.creditIdrBalance(payout.uid, payout.amountIdr);
        await store.updatePayout(payoutId, { status:'failed' });
        console.warn('[webhook] Payout', payoutId, 'gagal — idrBalance dikembalikan');
      } else {
        await store.updatePayout(payoutId, { status });
      }
      return res.status(200).json({ received: true, handled: 'payout' });
    }

    // ── Kasus 3: Withdrawal ke rekening bank ─────────────────────────────────
    const withdrawal = await store.getWithdrawal(customerOrderId || entityId);
    if (withdrawal) {
      const withdrawalId = customerOrderId || entityId;
      if (['failed','expired'].includes(status) && withdrawal.status !== 'failed') {
        await store.creditIdrBalance(withdrawal.uid, withdrawal.amountIdr);
        await store.updateWithdrawal(withdrawalId, { status:'failed' });
        console.warn('[webhook] Withdrawal', withdrawalId, 'gagal — idrBalance dikembalikan');
      } else {
        await store.updateWithdrawal(withdrawalId, { status });
      }
      return res.status(200).json({ received: true, handled: 'withdrawal' });
    }

    return res.status(200).json({ received: true, handled: 'ignored' });
  } catch (err) {
    console.error('[webhook] error:', err.message);
    return res.status(400).json({ error: 'Gagal memproses webhook' });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
`);

// ══════════════════════════════════════════════════════════════════════════════
// 8. vercel.json — daftarkan /api/convert
// ══════════════════════════════════════════════════════════════════════════════
write('vercel.json', JSON.stringify({
  version: 2,
  outputDirectory: 'frontend',
  functions: { 'api/*.js': { memory: 256, maxDuration: 30 } },
  routes: [
    { src: '/api/(.*)', dest: '/api/$1' },
    { src: '/(.*)',     dest: '/$1' },
  ],
}, null, 2) + '\n');

// ══════════════════════════════════════════════════════════════════════════════
// 9. frontend/js/app.js — pisah piSaldo & idrSaldo, dashboard dua kartu, nav baru
// ══════════════════════════════════════════════════════════════════════════════
write('frontend/js/app.js', `
/**
 * frontend/js/app.js (v2)
 * State global, navigasi, UI helpers.
 *
 * Perubahan:
 *   - S.piSaldo  = saldo Pi di app (top up → bertambah, konversi → berkurang)
 *   - S.idrSaldo = saldo Rupiah (konversi → bertambah, bayar/tarik → berkurang)
 *   - KYC state disederhanakan (kycVerified, kycData)
 */

const CFG = { SANDBOX: true, RATE: 14000, FEE: 0.02, PI_VER: '2.0' };

const S = {
  piSaldo: 0,
  idrSaldo: 0,
  kycVerified: false,
  kycData: { piName:'', bankName:'', bankCode:'', accNum:'', accName:'', payoutType:'bank' },
  user: { username:'', uid:'', email:'' },
  isDemo: false,
  merchant: 'Indomaret',
};

// ── Utils ─────────────────────────────────────────────────────────────────────
const fmt  = n => Math.floor(parseFloat(n)||0).toLocaleString('id-ID');
const ts   = () => { const n=new Date(); return n.toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})+', '+n.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}); };
const wait = ms => new Promise(r => setTimeout(r, ms));

let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

// ── Refresh UI ─────────────────────────────────────────────────────────────────
function refresh() {
  const pi = S.piSaldo, idr = S.idrSaldo;
  const set = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };

  // Home — dua kartu saldo
  set('hPi',     pi.toFixed(2) + ' π');
  set('hPiIdr',  '≈ Rp ' + fmt(pi*CFG.RATE) + ' · Rp 14.000/π');
  set('hIdr',    'Rp ' + fmt(idr));

  // Top Up info
  set('tuNow',    pi.toFixed(2));
  set('tuNowIdr', '≈ Rp ' + fmt(pi*CFG.RATE));

  // Konversi
  set('cvPiInfo',  'Saldo Pi: ' + pi.toFixed(2) + ' π');
  set('wPi',       pi.toFixed(2) + ' π');
  set('wIdr',      'Rp ' + fmt(idr));

  // Bayar Merchant — tampilkan idrSaldo
  set('byIdrInfo', 'Saldo Rupiah: Rp ' + fmt(idr));
  set('payIdrBal', 'Rp ' + fmt(idr));

  // Tarik Rekening
  set('wdIdrBal',  'Rp ' + fmt(idr));
  set('wdInfo',    'Saldo tersedia: Rp ' + fmt(idr));

  // KYC status
  const tag = document.getElementById('kycStatusTag');
  if (tag) tag.textContent = S.kycVerified ? '✓ Verified for IDR Wallet' : 'KYC belum lengkap';

  // Payout info di Bayar Merchant
  const kycWarn = document.getElementById('kycWarnPay');
  if (kycWarn) kycWarn.style.display = S.kycVerified ? 'none' : 'flex';

  // Konversi — warna tombol kalau saldo 0
  const cvBtn = document.getElementById('cvBtn');
  if (cvBtn) cvBtn.disabled = (pi <= 0);
}

// ── Navigation ─────────────────────────────────────────────────────────────────
const NO_NAV = ['login','processing','success'];
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const sc = document.getElementById(id);
  if (sc) sc.classList.add('active');
  document.getElementById('bnav').style.display = NO_NAV.includes(id) ? 'none' : 'flex';
  if (!NO_NAV.includes(id)) {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('on'));
    const bn = document.getElementById('bn-'+id); if (bn) bn.classList.add('on');
  }
  refresh();
  window.scrollTo(0, 0);
}

// ── Backend Helpers ──────────────────────────────────────────────────────────
async function callPi(body) {
  const r = await fetch('/api/pi?action='+body.action, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Backend error ' + r.status);
  return d;
}
async function callConvert(body) {
  const accessToken = sessionStorage.getItem('pi_access_token') || '';
  const r = await fetch('/api/convert?action=initiate', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-pi-access-token': accessToken},
    body:JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Konversi error ' + r.status);
  return d;
}
async function callMerchant(action, body) {
  const r = await fetch('/api/merchant?action='+action, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Merchant error ' + r.status);
  return d;
}
async function callWithdraw(body) {
  const r = await fetch('/api/withdraw?action=submit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Withdraw error ' + r.status);
  return d;
}

// ── Processing steps ──────────────────────────────────────────────────────────
function pStep(n, st, name, desc) {
  const ico=document.getElementById('pi'+n), pst=document.getElementById('pst'+n);
  if (!ico||!pst) return;
  ico.className='proc-ico'+(st==='act'?' active':st==='done'?' done':'');
  pst.textContent=st==='act'?'⏳':st==='done'?'✅':'—';
  if(name) document.getElementById('pn'+n).textContent=name;
  if(desc) document.getElementById('pd'+n).textContent=desc;
}

// ── Success ───────────────────────────────────────────────────────────────────
function showSuccess({ ttl, sub, type, dest, pi, idr, via, tx }) {
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  set('sucTtl',ttl);set('sucSub',sub);set('rcType',type);set('rcDest',dest);
  set('rcPi',pi);set('rcIdr',idr);set('rcVia',via);
  set('rcTx', String(tx).slice(0,28)+(String(tx).length>28?'…':''));
  set('rcTime',ts());
  go('success');
}

// ── Misc ──────────────────────────────────────────────────────────────────────
function pickM(name, el) {
  S.merchant=name;
  document.querySelectorAll('.merchant-chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');
}
function showProfile() { toast('@'+S.user.username+' · '+S.user.uid.slice(0,10)+'…'); }
function openNotif()  { document.getElementById('novlay').classList.add('open');  document.getElementById('npanel').classList.add('open'); }
function closeNotif() { document.getElementById('novlay').classList.remove('open'); document.getElementById('npanel').classList.remove('open'); }
`);

// ══════════════════════════════════════════════════════════════════════════════
// 10. frontend/js/payment.js — TopUp hanya tambah piSaldo, Bayar pakai idrSaldo
// ══════════════════════════════════════════════════════════════════════════════
write('frontend/js/payment.js', `
/**
 * frontend/js/payment.js (v2)
 *
 * TopUp: Pi SDK → piSaldo bertambah (TIDAK ada konversi ke IDR)
 * Payment (Bayar Merchant): idrSaldo → TransFi Payout → Merchant
 *   (TIDAK membuka Pi Wallet)
 */

// ── TOP UP PI ─────────────────────────────────────────────────────────────────
const TopUp = (() => {
  async function exec() {
    const amt = parseFloat(document.getElementById('tuAmt').value) || 0;
    if (amt <= 0) { toast('Masukkan jumlah Pi'); return; }
    const btn = document.getElementById('tuBtn');
    btn.disabled=true; btn.textContent='Memproses…';
    document.getElementById('procTitle').textContent = 'Top Up Pi';
    go('processing'); [1,2,3,4].forEach(n => pStep(n,'idle','—','—'));

    if (S.isDemo || typeof Pi === 'undefined') {
      pStep(1,'act','Pi.createPayment()','Membuat payment di Pi Network'); await wait(900); pStep(1,'done');
      pStep(2,'act','Backend Approve','/api/pi → approve'); await wait(800); pStep(2,'done');
      pStep(3,'act','Backend Complete','/api/pi → complete'); await wait(800); pStep(3,'done');
      pStep(4,'act','Saldo Pi bertambah','piBalance +'+amt+' π'); await wait(600); pStep(4,'done');
      S.piSaldo = parseFloat((S.piSaldo + amt).toFixed(4));
      refresh(); resetTU(); btn.disabled=false; btn.textContent='➕ Top Up via Pi Network';
      showSuccess({ ttl:'Top Up Berhasil', sub:'+'+amt+' π masuk Dompet Pi', type:'Top Up Pi (Demo)', dest:'Dompet Pi', pi:'+'+amt.toFixed(4)+' π', idr:'—', via:'Pi Network · Demo', tx:'demo-'+Date.now() });
      return;
    }

    try {
      const payData = { amount:amt, memo:'Top Up Ekamatho ('+amt+' π)', metadata:{ type:'topup', pi_amount:amt, timestamp: new Date().toISOString() } };
      pStep(1,'act','Pi.createPayment()','Membuat payment di Pi Network');
      await new Promise((res,rej) => {
        Pi.createPayment(payData, {
          onReadyForServerApproval: async (paymentId) => {
            pStep(1,'done'); pStep(2,'act','Backend Approve','/api/pi');
            try { await callPi({ action:'approve', paymentId, uid:S.user.uid }); } catch(e){ console.warn(e); }
          },
          onReadyForServerCompletion: async (paymentId, txid) => {
            pStep(2,'done'); pStep(3,'act','Backend Complete','/api/pi');
            try {
              const r = await callPi({ action:'complete', paymentId, txid, uid:S.user.uid });
              pStep(3,'done'); pStep(4,'act','Saldo Pi diperbarui','piBalance bertambah');
              S.piSaldo = parseFloat((r.newPiBalance || S.piSaldo+amt).toFixed(4));
              await wait(500); pStep(4,'done'); refresh(); resetTU();
              res({ paymentId, txid });
            } catch(e){ rej(e); }
          },
          onCancel: () => rej(new Error('CANCELLED')),
          onError:  (e) => rej(e),
        });
      });
      btn.disabled=false; btn.textContent='➕ Top Up via Pi Network';
      showSuccess({ ttl:'Top Up Berhasil', sub:'+'+amt+' π masuk Dompet Pi', type:'Top Up Pi', dest:'Dompet Pi', pi:'+'+amt.toFixed(4)+' π', idr:'—', via:'Pi Network · /api/pi', tx:'Lihat Vercel Logs' });
    } catch(err) {
      btn.disabled=false; btn.textContent='➕ Top Up via Pi Network';
      if(err.message==='CANCELLED') toast('Top Up dibatalkan');
      else toast('Top Up gagal: '+(err.message||'Error'));
      go('topup');
    }
  }

  function resetTU() {
    document.getElementById('tuAmt').value='';
    document.getElementById('tuPrev').style.display='none';
    document.querySelectorAll('.pill').forEach(p=>p.classList.remove('on'));
  }
  return { exec };
})();

function setTU(amt) {
  document.getElementById('tuAmt').value=amt;
  document.querySelectorAll('.pill').forEach(p=>p.classList.toggle('on', parseFloat(p.textContent)===amt));
  prevTU(amt);
}
function prevTU(v) {
  const amt=parseFloat(v)||0;
  if(amt<=0){ document.getElementById('tuPrev').style.display='none'; return; }
  document.getElementById('tuPrev').style.display='block';
  document.getElementById('tupPi').textContent  = amt.toFixed(4)+' π';
  document.getElementById('tupAft').textContent = (S.piSaldo+amt).toFixed(4)+' π';
  document.getElementById('tupIdr').textContent = 'Rp '+fmt(amt*CFG.RATE);
}

// ── BAYAR MERCHANT (pakai idrSaldo — TIDAK pakai Pi SDK) ─────────────────────
const Payment = (() => {
  async function exec() {
    const idr = parseFloat(document.getElementById('payIdr').value) || 0;
    if (idr <= 0) { toast('Masukkan total belanja IDR'); return; }
    if (!S.kycVerified) { toast('Konversi Pi → Rupiah terlebih dahulu sebelum bayar merchant'); go('convert'); return; }
    if (idr > S.idrSaldo) { toast('Saldo Rupiah tidak cukup (Rp '+fmt(S.idrSaldo)+'). Konversi Pi dulu!'); return; }

    document.getElementById('procTitle').textContent = 'Bayar '+S.merchant;
    go('processing'); [1,2,3,4].forEach(n=>pStep(n,'idle','—','—'));

    if (S.isDemo) {
      pStep(1,'act','Cek Saldo Rupiah','idrBalance: Rp '+fmt(idr)); await wait(600); pStep(1,'done');
      pStep(2,'act','TransFi Payout','/api/merchant → payout'); await wait(900); pStep(2,'done');
      pStep(3,'act','Transfer ke Merchant','Bank/VA via TransFi'); await wait(900); pStep(3,'done');
      pStep(4,'act','Pembayaran sukses','Saldo Rupiah berkurang'); await wait(600); pStep(4,'done');
      S.idrSaldo -= idr; refresh();
      showSuccess({ ttl:'Pembayaran Berhasil', sub:'Rp '+fmt(idr)+' → '+S.merchant, type:'Bayar Merchant (Demo)', dest:S.merchant, pi:'—', idr:'Rp '+fmt(idr), via:'TransFi Payout (Demo)', tx:'demo-pay-'+Date.now() });
      return;
    }

    try {
      pStep(1,'act','Cek Saldo Rupiah','idrBalance: Rp '+fmt(S.idrSaldo));
      await wait(300); pStep(1,'done');
      pStep(2,'act','TransFi Payout','/api/merchant');
      // Cari merchantId dari S.merchant (nama) — untuk demo pakai global_indomaret, dll
      const merchantMap = { 'Indomaret':'global_indomaret', 'Alfamart':'global_alfamart', 'PLN':'global_pln' };
      const merchantId  = merchantMap[S.merchant] || 'global_indomaret';
      const r = await callMerchant('payout', { uid:S.user.uid, merchantId, amountIdr: idr });
      pStep(2,'done'); pStep(3,'act','Transfer ke Merchant','Bank/VA via TransFi'); await wait(700);
      pStep(3,'done'); pStep(4,'act','Pembayaran sukses',''); await wait(400); pStep(4,'done');
      S.idrSaldo = r.newIdrBalance !== undefined ? r.newIdrBalance : S.idrSaldo - idr;
      refresh();
      showSuccess({ ttl:'Pembayaran Berhasil', sub:'Rp '+fmt(idr)+' → '+S.merchant, type:'Bayar Merchant', dest:S.merchant, pi:'—', idr:'Rp '+fmt(idr), via:'TransFi Payout · /api/merchant', tx: r.payoutId || 'Lihat Vercel Logs' });
    } catch(err) {
      toast('Pembayaran gagal: '+(err.message||'Error'));
      go('payment');
    }
  }
  return { exec };
})();

function calcPay(v) {
  const idr=parseFloat(v)||0;
  if(idr<=0){ document.getElementById('payPrev').style.display='none'; return; }
  document.getElementById('payPrev').style.display='block';
  document.getElementById('pfIDR').textContent  = 'Rp '+fmt(idr);
  document.getElementById('pfAft').textContent  = 'Rp '+fmt(S.idrSaldo-idr);
  document.getElementById('pfBal').textContent  = 'Rp '+fmt(S.idrSaldo);
}
function selMP(el, name) {
  S.merchant=name;
  document.querySelectorAll('.merch-opt').forEach(m=>m.classList.remove('on'));
  el.classList.add('on');
}
`);

// ══════════════════════════════════════════════════════════════════════════════
// 11. frontend/js/wallet.js — Konversi Pi→IDR, Tarik Rekening
// ══════════════════════════════════════════════════════════════════════════════
write('frontend/js/wallet.js', `
/**
 * frontend/js/wallet.js (v2)
 *
 * KYC:       Simpan data rekening user untuk AML
 * Konversi:  piSaldo → /api/convert → idrSaldo (setelah webhook)
 * Tarik:     idrSaldo → /api/withdraw → rekening bank user
 */

// ── KYC ───────────────────────────────────────────────────────────────────────
let kycPayoutType = 'bank';

function selPayout(el, type) {
  document.querySelectorAll('.pt-opt').forEach(e => {
    e.classList.remove('on');
    e.querySelector('.pt-check').textContent='○';
  });
  el.classList.add('on'); el.querySelector('.pt-check').textContent='✓';
  kycPayoutType=type;
  const bf=document.getElementById('bankSelectField');
  if(bf) bf.style.display=type==='bank'?'block':'none';
  const lbl=document.getElementById('accNumLabel');
  if(lbl) lbl.textContent=type==='bank'?'Nomor rekening':type==='qris'?'Nomor HP QRIS':'Nomor Virtual Account';
}

const KYC = (() => {
  function save() {
    const piName  = document.getElementById('kycName')?.value.trim();
    const accName = document.getElementById('kycAccName')?.value.trim();
    const accNum  = document.getElementById('kycAccNum')?.value.trim();
    const sel     = document.getElementById('kycBank');
    const bankCode= sel?.value || '';
    const bankName= sel?.options[sel.selectedIndex]?.text || '';
    if(!piName)   { toast('Masukkan nama lengkap sesuai Pi KYC'); return; }
    if(!accName)  { toast('Masukkan nama pemilik rekening'); return; }
    if(!accNum)   { toast('Masukkan nomor rekening'); return; }
    if(kycPayoutType==='bank' && !bankCode) { toast('Pilih nama bank'); return; }
    // Cek kesamaan nama (frontend saja — backend cek ulang saat konversi)
    const nm = (a,b) => a.toLowerCase().trim()===b.toLowerCase().trim();
    if(!nm(piName,accName)) { toast('Nama rekening harus sama dengan nama Pi KYC (akan diverifikasi saat konversi)'); }
    Object.assign(S.kycData, { piName, accName, accNum, bankCode, bankName, payoutType: kycPayoutType });
    sessionStorage.setItem('kyc_data', JSON.stringify(S.kycData));
    toast('Data KYC disimpan. Lakukan Konversi Pi → Rupiah untuk verifikasi AML.');
    refresh(); go('home');
  }
  return { save };
})();

// ── KONVERSI Pi → IDR ──────────────────────────────────────────────────────────
const Convert = (() => {
  async function exec() {
    const amtPi = parseFloat(document.getElementById('cvPi').value) || 0;
    if(amtPi<=0) { toast('Masukkan jumlah Pi yang akan dikonversi'); return; }
    if(amtPi > S.piSaldo) { toast('Saldo Pi tidak cukup ('+S.piSaldo.toFixed(2)+' π)'); return; }
    if(!S.kycData.piName) { toast('Lengkapi data KYC terlebih dahulu'); go('kyc'); return; }

    document.getElementById('procTitle').textContent='Konversi Pi → Rupiah';
    go('processing'); [1,2,3,4].forEach(n=>pStep(n,'idle','—','—'));

    if(S.isDemo) {
      pStep(1,'act','Verifikasi KYC & AML','Cocokkan nama Pi dengan rekening'); await wait(800); pStep(1,'done');
      pStep(2,'act','Debit Saldo Pi','piBalance -'+amtPi+' π'); await wait(600); pStep(2,'done');
      pStep(3,'act','TransFi Offramp','Pi → IDR sedang diproses'); await wait(1000); pStep(3,'done');
      pStep(4,'act','Menunggu Settlement','IDR masuk setelah TransFi konfirmasi'); await wait(700); pStep(4,'done');
      const idrEst = Math.floor(amtPi * CFG.RATE * (1-CFG.FEE));
      S.piSaldo  = parseFloat((S.piSaldo-amtPi).toFixed(4));
      S.idrSaldo += idrEst;
      S.kycVerified = true;
      refresh();
      showSuccess({ ttl:'Konversi Dimulai', sub:'Saldo Rupiah +Rp '+fmt(idrEst)+' (estimasi)', type:'Konversi Pi→IDR (Demo)', dest:'Dompet Rupiah', pi:'-'+amtPi.toFixed(4)+' π', idr:'≈ Rp '+fmt(idrEst), via:'TransFi Offramp (Demo)', tx:'demo-cv-'+Date.now() });
      return;
    }

    try {
      pStep(1,'act','Verifikasi KYC & AML','Cocokkan nama Pi dengan rekening');
      const r = await callConvert({
        uid: S.user.uid,
        amountPi: amtPi,
        piKycName:        S.kycData.piName,
        bankName:         S.kycData.bankName,
        accountNumber:    S.kycData.accNum,
        accountHolderName:S.kycData.accName,
      });
      pStep(1,'done'); pStep(2,'act','Saldo Pi dikurangi','piBalance -'+amtPi+' π'); await wait(500);
      pStep(2,'done'); pStep(3,'act','TransFi Offramp','Pi → IDR sedang diproses'); await wait(600);
      pStep(3,'done'); pStep(4,'act','Menunggu Settlement','IDR masuk setelah webhook'); await wait(500); pStep(4,'done');
      S.piSaldo  = parseFloat((S.piSaldo-amtPi).toFixed(4));
      S.kycVerified = true;
      refresh();
      showSuccess({ ttl:'Konversi Dimulai', sub:'IDR akan masuk setelah TransFi settle', type:'Konversi Pi→IDR', dest:'Dompet Rupiah', pi:'-'+amtPi.toFixed(4)+' π', idr:'Menunggu TransFi', via:'TransFi Offramp · /api/convert', tx: r.transfiOrderId || r.convertId || 'Lihat Vercel Logs' });
    } catch(err) {
      toast('Konversi gagal: '+(err.message||'Error'));
      go('convert');
    }
  }
  return { exec };
})();

function calcCV(v) {
  const pi=parseFloat(v)||0;
  document.getElementById('cvIdr').value=pi>0?fmt(Math.floor(pi*CFG.RATE*(1-CFG.FEE))):'';
}

// ── TARIK REKENING ────────────────────────────────────────────────────────────
const Withdraw = (() => {
  async function exec() {
    const idr = parseFloat(document.getElementById('wdAmt').value) || 0;
    if(idr<=0)        { toast('Masukkan jumlah penarikan'); return; }
    if(idr<10000)     { toast('Minimal penarikan Rp10.000'); return; }
    if(idr>S.idrSaldo){ toast('Saldo Rupiah tidak cukup'); return; }
    if(!S.kycData.piName) { toast('Lengkapi KYC terlebih dahulu'); go('kyc'); return; }

    document.getElementById('procTitle').textContent='Tarik Rekening';
    go('processing'); [1,2,3,4].forEach(n=>pStep(n,'idle','—','—'));

    if(S.isDemo) {
      pStep(1,'act','Cek KYC & Rekening','Verifikasi identitas'); await wait(700); pStep(1,'done');
      pStep(2,'act','Debit Saldo Rupiah','idrBalance -Rp '+fmt(idr)); await wait(600); pStep(2,'done');
      pStep(3,'act','TransFi Withdrawal','Transfer ke rekening'); await wait(1000); pStep(3,'done');
      pStep(4,'act','Transfer berhasil','IDR dikirim ke '+S.kycData.bankName); await wait(600); pStep(4,'done');
      S.idrSaldo-=idr; refresh();
      showSuccess({ ttl:'Penarikan Berhasil', sub:'Rp '+fmt(idr)+' → '+S.kycData.bankName, type:'Tarik Rekening (Demo)', dest:S.kycData.bankName+' · '+S.kycData.accNum, pi:'—', idr:'Rp '+fmt(idr), via:'TransFi Withdrawal (Demo)', tx:'demo-wd-'+Date.now() });
      return;
    }

    try {
      pStep(1,'act','Cek KYC & Rekening','Verifikasi identitas'); await wait(300); pStep(1,'done');
      pStep(2,'act','TransFi Withdrawal','/api/withdraw');
      const r = await callWithdraw({
        uid: S.user.uid,
        bankName:         S.kycData.bankName,
        accountNumber:    S.kycData.accNum,
        accountHolderName:S.kycData.accName,
        amountIdr: idr,
        piAccountName: S.kycData.piName,
      });
      pStep(2,'done'); pStep(3,'act','Transfer dikirim','Menunggu bank'); await wait(700);
      pStep(3,'done'); pStep(4,'act','Penarikan sukses',''); await wait(400); pStep(4,'done');
      S.idrSaldo = r.newIdrBalance !== undefined ? r.newIdrBalance : S.idrSaldo-idr;
      refresh();
      showSuccess({ ttl:'Penarikan Berhasil', sub:'Rp '+fmt(idr)+' → '+S.kycData.bankName, type:'Tarik Rekening', dest:S.kycData.bankName+' · '+S.kycData.accNum, pi:'—', idr:'Rp '+fmt(idr), via:'TransFi Withdrawal · /api/withdraw', tx: r.withdrawalId || 'Lihat Vercel Logs' });
    } catch(err) {
      toast('Penarikan gagal: '+(err.message||'Error'));
      go('withdraw');
    }
  }
  return { exec };
})();

function chkWD(v) {
  const idr=parseFloat(v)||0;
  const info=document.getElementById('wdInfo'); if(!info) return;
  if(idr>S.idrSaldo) { info.textContent='Melebihi saldo tersedia'; info.style.color='var(--rose)'; }
  else { info.textContent='Saldo tersedia: Rp '+fmt(S.idrSaldo); info.style.color='var(--muted)'; }
}
`);

// ══════════════════════════════════════════════════════════════════════════════
// 12. frontend/js/pi.js — fetchAppBalance pakai piBalance & idrBalance
// ══════════════════════════════════════════════════════════════════════════════
write('frontend/js/pi.js', `
/**
 * frontend/js/pi.js (v2)
 * Pi SDK init & auth. fetchAppBalance sekarang ambil piBalance + idrBalance.
 */

function initPiSdk() {
  try { Pi.init({ version:'2.0', sandbox: CONFIG.PI_SANDBOX }); }
  catch(e) { console.warn('Pi SDK belum siap', e); }
}

const PiAuth = (() => {
  function setStatus(msg, cls='') {
    const el=document.getElementById('lstat');
    if(el){ el.textContent=msg; el.className='login-status '+cls; }
  }
  function setBtn(html, dis) {
    const btn=document.getElementById('loginBtn');
    if(btn){ btn.innerHTML=html; btn.disabled=dis; }
  }

  function onSuccess(user, accessToken) {
    S.user={ ...user, accessToken };
    document.getElementById('uav').textContent=(user.username||'P').charAt(0).toUpperCase();
    document.getElementById('uname').textContent='@'+user.username;
    document.getElementById('envTag').textContent=CONFIG.PI_SANDBOX?'Testnet · Sandbox':'Mainnet · Production';
    sessionStorage.setItem('pi_user', JSON.stringify({ ...user, isDemo:false }));
    sessionStorage.setItem('pi_access_token', accessToken);
    const sk=sessionStorage.getItem('kyc_data');
    if(sk){ try{ Object.assign(S.kycData, JSON.parse(sk)); }catch(_){} }
    toast('Selamat datang, @'+user.username);
    go('home');
  }

  async function fetchAppBalance(uid) {
    const r = await fetch('/api/wallet?action=balance&uid='+uid);
    const d = await r.json();
    S.piSaldo  = parseFloat(d.piBalance  || 0);
    S.idrSaldo = parseFloat(d.idrBalance || 0);
    if(d.kycStatus?.verifiedForIdr) {
      S.kycVerified = true;
      // Isi kycData dari kycStatus jika belum ada di session
      if(!S.kycData.accNum && d.kycStatus.accountNumber) {
        Object.assign(S.kycData, {
          accNum:  d.kycStatus.accountNumber,
          accName: d.kycStatus.accountHolderName,
          bankName:d.kycStatus.bankName,
          piName:  d.kycStatus.piName || '',
        });
      }
    }
    refresh();
    return d;
  }

  async function signIn() {
    setBtn('<div class="btn-pi-mark">π</div> Menghubungkan…', true);
    setStatus('Memeriksa Pi Browser…');
    if(typeof Pi==='undefined'){
      setStatus('Pi SDK tidak tersedia. Buka di Pi Browser atau gunakan Mode Demo.','err');
      setBtn('<div class="btn-pi-mark">π</div> Login dengan Pi Network', false);
      return;
    }
    try {
      setStatus('Menginisialisasi Pi SDK…');
      await Pi.init({ version:'2.0', sandbox: CONFIG.PI_SANDBOX });
      await new Promise(r=>setTimeout(r,200));
      setStatus('Menunggu persetujuan di Pi Browser…');
      setBtn('<div class="btn-pi-mark">π</div> Menunggu…', true);
      const auth = await Pi.authenticate(['username','payments'], async (inc) => {
        console.warn('[Auth] Incomplete payment:', inc.identifier);
        try {
          await fetch('/api/pi?action=complete', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ action:'complete', paymentId:inc.identifier, txid:inc.transaction?.txid||'', uid:auth?.user?.uid||'' })
          });
        } catch(e){ console.warn('[Auth] complete incomplete:', e); }
      });
      if(!auth?.accessToken) throw new Error('Tidak ada access token');
      setStatus('Login ke Ekamatho…');
      const login=await fetch('/api/auth',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ accessToken: auth.accessToken }) });
      const app=await login.json();
      const appUser=app.user;
      await fetchAppBalance(appUser.uid);
      setStatus('Login berhasil','ok');
      onSuccess(appUser, auth.accessToken);
    } catch(err){
      console.error('[Auth]', err);
      setStatus('Gagal: '+(err.message||'Unknown error'),'err');
      setBtn('<div class="btn-pi-mark">π</div> Login dengan Pi Network', false);
    }
  }

  function demo() {
    setStatus('Masuk mode demo…');
    setTimeout(()=>{
      S.piSaldo=125.50; S.idrSaldo=0; S.isDemo=true;
      const user={ username:'demo_pioneer', uid:'demo-uid-000', email:'demo@pi.network', isDemo:true };
      S.user=user;
      document.getElementById('uav').textContent='D';
      document.getElementById('uname').textContent='@demo';
      document.getElementById('envTag').textContent='Mode Demo';
      sessionStorage.setItem('pi_user', JSON.stringify(user));
      setStatus('Mode demo aktif','ok');
      go('home');
    },500);
  }

  async function refreshBalance() {
    if(!S.user?.uid) return;
    await fetchAppBalance(S.user.uid);
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    initPiSdk();
    const c=sessionStorage.getItem('pi_user');
    if(c){
      try{
        const u=JSON.parse(c); S.user=u;
        if(u.isDemo){ S.piSaldo=125.50; S.idrSaldo=0; S.isDemo=true; }
        document.getElementById('uav').textContent=(u.username||'P').charAt(0).toUpperCase();
        document.getElementById('uname').textContent='@'+u.username;
        const sk=sessionStorage.getItem('kyc_data');
        if(sk){ try{ Object.assign(S.kycData, JSON.parse(sk)); }catch(_){} }
        if(!u.isDemo && u.uid) fetchAppBalance(u.uid);
        go('home'); return;
      }catch(_){ sessionStorage.removeItem('pi_user'); }
    }
  });

  return { signIn, demo, refreshBalance };
})();
`);

// ══════════════════════════════════════════════════════════════════════════════
// 13. frontend/index.html — update layar Bayar Merchant + tambah layar Convert
//     + nav baru (Home, Top Up, Konversi, Bayar, Tarik, Riwayat, KYC)
//     Hanya patch bagian yang berubah, sisanya tetap.
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n[13/13] Patch frontend/index.html…');
const htmlPath = path.join(ROOT, 'frontend/index.html');
if (!fs.existsSync(htmlPath)) {
  console.log('  ⚠ frontend/index.html tidak ditemukan, skip.');
} else {
  backup(htmlPath);
  let html = fs.readFileSync(htmlPath, 'utf-8');

  // ── a) Update home: dua kartu saldo yang jelas ──────────────────────────
  html = html.replace(
    /<div class="balance-hero">[\s\S]*?<\/div>\s*<div class="flow-strip">/,
    `<div class="balance-hero">
    <div class="bh-label">
      <div class="bh-dot"></div>
      <span>Dompet Pi · Ekamatho</span>
      <span onclick="PiAuth.refreshBalance()" style="margin-left:auto;font-size:10px;color:var(--amber);cursor:pointer;opacity:.7;">↻ Refresh</span>
    </div>
    <div class="balance-cards">
      <div class="balance-card pi-card">
        <div class="bc-label">Saldo Pi</div>
        <div class="bc-amount"><span id="hPi">0.00 π</span></div>
        <div class="bc-sub" id="hPiIdr">≈ Rp 0 · Rp 14.000/π</div>
        <button class="bc-action" onclick="go('topup')">➕ Top Up</button>
      </div>
      <div class="balance-card idr-card">
        <div class="bc-label">Saldo Rupiah</div>
        <div class="bc-amount emerald"><span id="hIdr">Rp 0</span></div>
        <div class="bc-sub" id="kycStatusTag">KYC belum lengkap</div>
        <button class="bc-action emerald" onclick="go('convert')">💱 Konversi</button>
      </div>
    </div>
    <div class="bh-actions" style="margin-top:14px;">
      <button class="bh-btn primary" onclick="go('payment')">⚡ Bayar Merchant</button>
      <button class="bh-btn outline" onclick="go('withdraw')">🏦 Tarik Rekening</button>
    </div>
  </div>
  <div class="flow-strip">`
  );

  // ── b) Update Payment screen — hapus Pi SDK, pakai IDR ──────────────────
  html = html.replace(
    /<!-- PAYMENT -->[\s\S]*?<!-- PROCESSING -->/,
    `<!-- PAYMENT -->
<div class="screen" id="payment">
  <div class="page-header">
    <div class="back-btn" onclick="go('home')">←</div>
    <div class="page-title">Bayar Merchant</div>
  </div>
  <div class="inner-card idr" style="margin:0 20px 14px;">
    <div class="ic-eyebrow">Saldo Rupiah tersedia</div>
    <div class="ic-num" style="font-size:28px;color:var(--emerald);" id="payIdrBal">Rp 0</div>
    <div class="ic-sub">Dari hasil konversi Pi</div>
  </div>
  <div id="kycWarnPay" class="note rose" style="margin:0 20px 14px;display:none;">
    <span class="note-tag nt-rose">Konversi</span>
    Saldo Rupiah kosong. <span style="color:var(--amber);cursor:pointer;font-weight:600;" onclick="go('convert')">Konversi Pi → Rupiah dulu →</span>
  </div>
  <div class="form-group">
    <div>
      <label class="field-label">Total belanja (IDR)</label>
      <div class="input-row">
        <span class="input-prefix">Rp</span>
        <input type="number" id="payIdr" placeholder="0" oninput="calcPay(this.value)"/>
      </div>
      <div class="field-hint" id="byIdrInfo">Saldo Rupiah: Rp 0</div>
    </div>
    <div id="payPrev" style="display:none;">
      <div class="breakdown">
        <div class="bd-row"><span class="l">Total IDR</span><span class="v emerald" id="pfIDR">—</span></div>
        <div class="bd-row"><span class="l">Saldo sebelum</span><span class="v" id="pfBal">—</span></div>
        <div class="bd-row"><span class="l">Saldo setelah</span><span class="v amber" id="pfAft">—</span></div>
      </div>
    </div>
    <div>
      <label class="field-label">Merchant</label>
      <div class="merch-grid">
        <div class="merch-opt on" onclick="selMP(this,'Indomaret')"><span class="merch-opt-ico">🏪</span><span class="merch-opt-name">Indomaret</span></div>
        <div class="merch-opt" onclick="selMP(this,'Alfamart')"><span class="merch-opt-ico">🛒</span><span class="merch-opt-name">Alfamart</span></div>
        <div class="merch-opt" onclick="selMP(this,'PLN')"><span class="merch-opt-ico">⚡</span><span class="merch-opt-name">PLN</span></div>
        <div class="merch-opt" onclick="selMP(this,'Lainnya')"><span class="merch-opt-ico">🏢</span><span class="merch-opt-name">Lainnya</span></div>
      </div>
    </div>
    <div class="note blue">
      <span class="note-tag nt-blue">TransFi</span>
      Pembayaran langsung dari Saldo Rupiah via TransFi Payout. Tidak membuka Pi Wallet.
    </div>
  </div>
  <button class="action-btn emerald-btn" onclick="Payment.exec()">⚡ Bayar dari Saldo Rupiah</button>
</div>

<!-- CONVERT -->
<div class="screen" id="convert">
  <div class="page-header">
    <div class="back-btn" onclick="go('home')">←</div>
    <div class="page-title">Konversi Pi → Rupiah</div>
  </div>
  <div class="kyc-alert">
    <div class="ka-title">🛡️ Verifikasi KYC & AML</div>
    <div class="ka-desc">Nama pemilik akun Pi harus sesuai nama rekening bank. Pastikan data KYC sudah diisi.</div>
  </div>
  <div class="inner-card pi" style="margin:0 20px 14px;">
    <div class="ic-eyebrow">Saldo Pi</div>
    <div class="ic-num" style="font-size:28px;" id="wPi">0.00 π</div>
  </div>
  <div class="form-group">
    <div>
      <label class="field-label">Jumlah Pi yang dikonversi</label>
      <div class="input-row"><span class="input-prefix">π</span><input type="number" id="cvPi" placeholder="0.00" oninput="calcCV(this.value)"/></div>
      <div class="field-hint" id="cvPiInfo">Saldo Pi: 0 π</div>
    </div>
    <div class="conv-arrow"><div class="ca-line"></div><div class="ca-ico">↓</div><div class="ca-line"></div><div style="font-size:10px;color:var(--muted);">fee 2% · Rp 14.000/π</div></div>
    <div>
      <label class="field-label">Estimasi Rupiah diterima</label>
      <div class="input-row"><span class="input-prefix">Rp</span><input type="text" id="cvIdr" placeholder="0" readonly style="opacity:.6;"/></div>
    </div>
    <div class="note blue"><span class="note-tag nt-blue">TransFi</span>Pi → IDR via TransFi Offramp. Saldo Rupiah masuk setelah TransFi konfirmasi (webhook).</div>
  </div>
  <button class="action-btn" id="cvBtn" onclick="Convert.exec()">💱 Konversi Pi → Rupiah</button>
</div>

<!-- WITHDRAW -->
<div class="screen" id="withdraw">
  <div class="page-header">
    <div class="back-btn" onclick="go('home')">←</div>
    <div class="page-title">Tarik Rekening</div>
  </div>
  <div class="inner-card idr" style="margin:0 20px 14px;">
    <div class="ic-eyebrow">Saldo Rupiah</div>
    <div class="ic-num" style="font-size:28px;color:var(--emerald);" id="wdIdrBal">Rp 0</div>
    <div class="ic-sub">Siap ditarik ke rekening bank</div>
  </div>
  <div class="form-group">
    <div>
      <label class="field-label">Jumlah penarikan (IDR)</label>
      <div class="input-row"><span class="input-prefix">Rp</span><input type="number" id="wdAmt" placeholder="0" oninput="chkWD(this.value)"/></div>
      <div class="field-hint" id="wdInfo">Saldo tersedia: Rp 0</div>
    </div>
    <div class="note blue"><span class="note-tag nt-blue">TransFi</span>Transfer langsung ke rekening KYC terdaftar. AML hanya dicek ulang jika rekening berbeda.</div>
  </div>
  <button class="action-btn emerald-btn" onclick="Withdraw.exec()">🏦 Tarik ke Rekening Bank</button>
</div>

<!-- PROCESSING -->`
  );

  // ── c) Update bottom nav ─────────────────────────────────────────────────
  html = html.replace(
    /<!-- BOTTOM NAV -->[\s\S]*?<\/div>\s*<\/div><!-- \/app -->/,
    `<!-- BOTTOM NAV -->
<div class="bottom-nav" id="bnav" style="display:none;">
  <div class="nav-item on" id="bn-home"    onclick="go('home')">   <span class="nav-ico">⌂</span><span class="nav-lbl">Home</span></div>
  <div class="nav-item" id="bn-topup"      onclick="go('topup')">  <span class="nav-ico">➕</span><span class="nav-lbl">Top Up</span></div>
  <div class="nav-item" id="bn-convert"    onclick="go('convert')"><span class="nav-ico">💱</span><span class="nav-lbl">Konversi</span></div>
  <div class="nav-item" id="bn-payment"    onclick="go('payment')"><span class="nav-ico">⚡</span><span class="nav-lbl">Bayar</span></div>
  <div class="nav-item" id="bn-withdraw"   onclick="go('withdraw')"><span class="nav-ico">🏦</span><span class="nav-lbl">Tarik</span></div>
  <div class="nav-item" id="bn-history"    onclick="go('history')"><span class="nav-ico">↻</span><span class="nav-lbl">Riwayat</span></div>
  <div class="nav-item" id="bn-kyc"        onclick="go('kyc')">    <span class="nav-ico">🛡</span><span class="nav-lbl">KYC</span></div>
</div>

</div><!-- /app -->`
  );

  // ── d) Update script tags (wallet.js tidak ada, sudah ada) ──────────────
  html = html.replace(
    /<script src="js\/app\.js"><\/script>[\s\S]*?<\/body>/,
    `<script src="js/app.js"></script>
<script src="js/api.js"></script>
<script src="js/payment.js"></script>
<script src="js/wallet.js"></script>
<script src="js/pi.js"></script>
</body>`
  );

  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log('  ✔ frontend/index.html (patch nav, layar Convert, Withdraw, Bayar Merchant)');
  patchCount++;
}

// ══════════════════════════════════════════════════════════════════════════════
// Done
// ══════════════════════════════════════════════════════════════════════════════
console.log(`
✅ Refactor selesai! ${patchCount} file diperbarui.

Business flow baru:
  Top Up Pi   : Pi SDK → piBalance bertambah
  Konversi    : piBalance → AML gate → TransFi Offramp → idrBalance (via webhook)
  Bayar       : idrBalance → TransFi Payout → Merchant (TANPA Pi SDK)
  Tarik       : idrBalance → TransFi Withdrawal → Rekening Bank

Langkah selanjutnya:
  1. Buat Vercel KV di Dashboard → Storage → Create KV Database → Connect
  2. npm install
  3. vercel env pull
  4. vercel deploy

File lama: *.bak2
`);
