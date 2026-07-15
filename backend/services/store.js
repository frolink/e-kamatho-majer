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
