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
