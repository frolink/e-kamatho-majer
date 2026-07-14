/**
 * lib/store.js
 * -----------------------------------------------------------------------
 * Penyimpanan sederhana berbasis file JSON.
 *
 * ⚠️ PENTING UNTUK VERCEL:
 * Serverless function di Vercel TIDAK punya filesystem persisten. Tiap
 * invocation bisa jatuh ke instance berbeda, dan /tmp bisa hilang kapan
 * saja. File ini membuat project BISA di-deploy & dites end-to-end tanpa
 * setup database dulu — tapi saldo/riwayat TIDAK dijamin konsisten di
 * production dengan trafik nyata.
 *
 * SEBELUM PRODUKSI SUNGGUHAN: ganti isi file ini dengan database asli
 * (Vercel Postgres, Vercel KV, Supabase, dll). Semua fungsi sengaja
 * `async` walau isinya sinkron, supaya api/*.js tidak perlu diubah saat
 * store.js diganti ke DB asli.
 * -----------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.VERCEL
  ? path.join('/tmp', 'ekamatho-db.json')
  : path.join(__dirname, '..', 'data', 'db.json');

function ensureDir() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function defaultMerchants() {
  // Data rekening/VA di bawah ini CONTOH — ganti dengan nomor VA/rekening
  // resmi hasil kerja sama/pendaftaran nyata dengan masing-masing merchant
  // sebelum dipakai sungguhan. Untuk Indomaret khususnya, pembayaran via
  // Virtual Account biasanya digenerate per-transaksi oleh penyedia VA
  // mereka (mis. lewat kerja sama dengan bank/payment gateway) — nomor
  // statis di sini hanya placeholder demo.
  return {
    'global_indomaret': {
      merchantId: 'global_indomaret', scope: 'global', name: 'Indomaret',
      category: 'Retail', paymentCode: 'virtual_account',
      bankName: 'BRI', accountNumber: '777081234567890', accountHolderName: 'PT Indomarco Prismatama'
    },
    'global_alfamart': {
      merchantId: 'global_alfamart', scope: 'global', name: 'Alfamart',
      category: 'Retail', paymentCode: 'virtual_account',
      bankName: 'Permata', accountNumber: '888091234567890', accountHolderName: 'PT Sumber Alfaria Trijaya'
    },
    'global_pln': {
      merchantId: 'global_pln', scope: 'global', name: 'PLN (Token Listrik)',
      category: 'Utilitas', paymentCode: 'virtual_account',
      bankName: 'BNI', accountNumber: '888888012345678', accountHolderName: 'PT PLN (Persero)'
    }
  };
}

function loadDb() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: {}, piPayments: {}, transfiOrders: {}, payouts: {}, withdrawals: {}, merchants: defaultMerchants(), transactions: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!db.merchants || Object.keys(db.merchants).length === 0) db.merchants = defaultMerchants();
    return db;
  }
  catch { return { users: {}, piPayments: {}, transfiOrders: {}, payouts: {}, withdrawals: {}, merchants: defaultMerchants(), transactions: [] }; }
}

function saveDb(db) { ensureDir(); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ---------- USERS ----------
async function upsertUser({ uid, username, piAddress }) {
  const db = loadDb();
  const existing = db.users[uid] || { appBalance: 0 };
  db.users[uid] = { ...existing, uid, username, piAddress: piAddress || existing.piAddress || null };
  saveDb(db);
  return db.users[uid];
}
async function getUser(uid) { return loadDb().users[uid] || null; }
async function getAppBalance(uid) { const db = loadDb(); return db.users[uid] ? db.users[uid].appBalance : 0; }

async function creditAppBalance(uid, amount) {
  const db = loadDb();
  if (!db.users[uid]) db.users[uid] = { uid, appBalance: 0 };
  db.users[uid].appBalance = Number(db.users[uid].appBalance || 0) + Number(amount);
  saveDb(db);
  return db.users[uid].appBalance;
}
async function debitAppBalance(uid, amount) {
  const db = loadDb();
  if (!db.users[uid]) db.users[uid] = { uid, appBalance: 0 };
  const current = Number(db.users[uid].appBalance || 0);
  if (current < amount) throw new Error('Saldo Rupiah tidak cukup');
  db.users[uid].appBalance = current - Number(amount);
  saveDb(db);
  return db.users[uid].appBalance;
}

// ---------- PI PAYMENTS (khusus Top Up, jalur resmi Pi Testnet) ----------
async function getPiPayment(paymentId) { return loadDb().piPayments[paymentId] || null; }
async function savePiPaymentApproved(paymentId, data) {
  const db = loadDb();
  db.piPayments[paymentId] = { ...(db.piPayments[paymentId] || {}), ...data, status: 'approved' };
  saveDb(db);
  return db.piPayments[paymentId];
}
async function savePiPaymentCompleted(paymentId, data) {
  const db = loadDb();
  db.piPayments[paymentId] = { ...(db.piPayments[paymentId] || {}), ...data, status: 'completed' };
  saveDb(db);
  return db.piPayments[paymentId];
}

// ---------- TRANSFI OFFRAMP ORDERS (Pi -> IDR, dipicu setelah Top Up) ----------
async function createTransfiOrder(order) {
  const db = loadDb();
  db.transfiOrders[order.orderId] = { ...order, status: order.status || 'initiated' };
  saveDb(db);
  return db.transfiOrders[order.orderId];
}
async function getTransfiOrder(orderId) { return loadDb().transfiOrders[orderId] || null; }
async function updateTransfiOrder(orderId, data) {
  const db = loadDb();
  db.transfiOrders[orderId] = { ...(db.transfiOrders[orderId] || {}), ...data };
  saveDb(db);
  return db.transfiOrders[orderId];
}
async function findTransfiOrderByPiPaymentId(paymentId) {
  const db = loadDb();
  return Object.values(db.transfiOrders).find(o => o.piPaymentId === paymentId) || null;
}

// ---------- PAYOUTS (saldo Rupiah -> merchant terdaftar, Bank/VA) ----------
async function createPayout(payout) {
  const db = loadDb();
  db.payouts[payout.payoutId] = { ...payout, status: payout.status || 'pending' };
  saveDb(db);
  return db.payouts[payout.payoutId];
}
async function getPayout(payoutId) { return loadDb().payouts[payoutId] || null; }
async function updatePayout(payoutId, data) {
  const db = loadDb();
  db.payouts[payoutId] = { ...(db.payouts[payoutId] || {}), ...data };
  saveDb(db);
  return db.payouts[payoutId];
}

// ---------- WITHDRAWALS (saldo Rupiah -> rekening bank pribadi user, dengan AML) ----------
async function createWithdrawal(w) {
  const db = loadDb();
  db.withdrawals[w.withdrawalId] = { ...w, status: w.status || 'pending' };
  saveDb(db);
  return db.withdrawals[w.withdrawalId];
}
async function getWithdrawal(withdrawalId) { return loadDb().withdrawals[withdrawalId] || null; }
async function updateWithdrawal(withdrawalId, data) {
  const db = loadDb();
  db.withdrawals[withdrawalId] = { ...(db.withdrawals[withdrawalId] || {}), ...data };
  saveDb(db);
  return db.withdrawals[withdrawalId];
}

// ---------- MERCHANTS (terdaftar dengan rekening/VA asli, bukan data contoh) ----------
async function createMerchant(m) {
  const db = loadDb();
  db.merchants[m.merchantId] = { ...m };
  saveDb(db);
  return db.merchants[m.merchantId];
}
async function getMerchant(merchantId) { return loadDb().merchants[merchantId] || null; }
// scope 'global' = tersedia untuk semua user (default bawaan app, mis. Indomaret).
// selain itu, merchant milik uid tertentu saja yang melihatnya (custom warung pribadi).
async function listMerchants(uid) {
  const db = loadDb();
  return Object.values(db.merchants).filter(m => m.scope === 'global' || m.ownerUid === uid);
}

// ---------- TRANSAKSI (riwayat gabungan) ----------
async function addTransaction(tx) {
  const db = loadDb();
  db.transactions.unshift({ ...tx, createdAt: new Date().toISOString() });
  saveDb(db);
}
async function listTransactions(uid) { return loadDb().transactions.filter(t => t.uid === uid); }

module.exports = {
  upsertUser, getUser, getAppBalance, creditAppBalance, debitAppBalance,
  getPiPayment, savePiPaymentApproved, savePiPaymentCompleted,
  createTransfiOrder, getTransfiOrder, updateTransfiOrder, findTransfiOrderByPiPaymentId,
  createPayout, getPayout, updatePayout,
  createWithdrawal, getWithdrawal, updateWithdrawal,
  createMerchant, getMerchant, listMerchants,
  addTransaction, listTransactions
};
