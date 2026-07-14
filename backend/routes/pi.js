/**
 * /api/pi — khusus Top Up Pi (Pi Testnet Wallet), TIDAK ADA logika merchant/payout.
 *
 *   GET  /api/pi?action=wallet-balance&uid=...
 *   POST /api/pi?action=approve    body: { paymentId, uid }
 *   POST /api/pi?action=complete   body: { paymentId, txid, uid }
 *
 * complete() adalah titik sambung tunggal ke TransFi: setelah Pi Platform
 * mengonfirmasi payment selesai (Pi resmi masuk ke wallet developer), kita
 * memanggil lib/transfiClient.createOfframpOrder() untuk mulai konversi
 * Pi -> IDR. Saldo Rupiah TIDAK langsung bertambah di sini — itu baru
 * terjadi saat /api/webhook menerima konfirmasi settle dari TransFi.
 */
const axios = require('axios');
const piClient = require('../services/piClient');
const transfiClient = require('../services/transfiClient');
const store = require('../services/store');

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.testnet.minepi.com';

// Cache in-memory ringan (hidup selama instance serverless "hangat") supaya
// tidak boros kuota kalau frontend sering memanggil "↻ Sinkron" berturut-turut.
const balanceCache = new Map();
const BALANCE_CACHE_TTL_MS = 10_000;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  try {
    if (req.method === 'GET' && action === 'wallet-balance') return await walletBalance(req, res);
    if (req.method === 'POST' && action === 'approve') return await approve(req, res);
    if (req.method === 'POST' && action === 'complete') return await complete(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/pi' });
  } catch (err) {
    console.error('api/pi error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Terjadi kesalahan pada Top Up Pi' });
  }
};

async function approve(req, res) {
  const { paymentId, uid } = req.body || {};
  if (!paymentId || !uid) return res.status(400).json({ error: 'paymentId & uid wajib diisi' });

  const payment = await piClient.getPayment(paymentId);
  if (payment.user_uid !== uid) return res.status(403).json({ error: 'Payment tidak sesuai dengan user ini' });
  if (payment.status && payment.status.developer_approved) return res.json({ ok: true, alreadyApproved: true });

  await piClient.approvePayment(paymentId);
  await store.savePiPaymentApproved(paymentId, { paymentId, uid, amount: payment.amount, memo: payment.memo });
  return res.json({ ok: true });
}

async function complete(req, res) {
  const { paymentId, txid, uid } = req.body || {};
  if (!paymentId || !txid || !uid) return res.status(400).json({ error: 'paymentId, txid & uid wajib diisi' });

  const existing = await store.getPiPayment(paymentId);
  if (existing && existing.status === 'completed') {
    const existingOrder = await store.findTransfiOrderByPiPaymentId(paymentId);
    return res.json({
      amountPi: existing.amount, piTxId: existing.txid,
      transfiOrderId: existingOrder ? existingOrder.orderId : null
    });
  }

  const payment = await piClient.getPayment(paymentId);
  if (payment.user_uid !== uid) return res.status(403).json({ error: 'Payment tidak sesuai dengan user ini' });

  // Langkah wajib alur resmi Pi: tandai selesai di Pi Server.
  // Setelah baris ini, Pi SUDAH masuk ke wallet developer (app).
  await piClient.completePayment(paymentId, txid);
  await store.savePiPaymentCompleted(paymentId, { paymentId, uid, amount: payment.amount, txid });
  await store.addTransaction({ uid, type: 'pi_completed', name: 'Pi Payment selesai', amountPi: payment.amount, txid, paymentId });

  const user = await store.getUser(uid);

  // ---- Titik sambung ke TransFi: mulai proses swap Pi -> IDR ----
  // Catatan AML: pengecekan "nama rekening tujuan harus sama dengan nama
  // akun Pi" dilakukan di api/withdraw.js (saat user menarik saldo Rupiah
  // ke rekening bank pribadi) — BUKAN di sini. Swap ini hanya memindahkan
  // Pi milik user sendiri menjadi saldo Rupiah di ledger app milik user
  // yang sama, jadi belum ada risiko dana keluar ke pihak lain.
  let transfiOrderId = null;
  try {
    const order = await transfiClient.createOfframpOrder({
      customerOrderId: paymentId, // dipakai webhook utk mencocokkan balik ke top up ini
      cryptoTicker: 'PI',
      depositAmount: payment.amount,
      withdrawCurrency: 'IDR',
      customerName: user?.username || uid
    });
    transfiOrderId = order.orderId || order.data?.orderId;
    await store.createTransfiOrder({
      orderId: transfiOrderId, uid, piPaymentId: paymentId,
      depositAmount: payment.amount, depositCurrency: 'PI', withdrawCurrency: 'IDR',
      status: 'initiated', raw: order
    });
  } catch (err) {
    // Pi SUDAH diterima walau order TransFi gagal dibuat — jangan hilangkan
    // fakta ini. Catat sebagai order berstatus 'error' supaya bisa
    // direkonsiliasi/retry manual, tapi tetap balas sukses ke client karena
    // dari sisi Pi Payment memang sudah selesai.
    console.error('Gagal membuat order Offramp TransFi:', err.response?.data || err.message);
    await store.createTransfiOrder({
      orderId: 'error_' + paymentId, uid, piPaymentId: paymentId,
      depositAmount: payment.amount, status: 'error', errorMessage: err.message
    });
  }

  return res.json({ amountPi: payment.amount, piTxId: txid, transfiOrderId });
}

async function walletBalance(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });

  const user = await store.getUser(uid);
  if (!user || !user.piAddress) return res.json({ piBalance: 0, piAddress: null });

  const cached = balanceCache.get(user.piAddress);
  if (cached && Date.now() - cached.at < BALANCE_CACHE_TTL_MS) {
    return res.json({ piBalance: cached.piBalance, piAddress: user.piAddress, cached: true });
  }

  try {
    const acctRes = await axios.get(`${HORIZON_URL}/accounts/${user.piAddress}`, { timeout: 15000 });
    const native = (acctRes.data.balances || []).find(b => b.asset_type === 'native');
    const piBalance = native ? Number(native.balance) : 0;
    balanceCache.set(user.piAddress, { at: Date.now(), piBalance });
    return res.json({ piBalance, piAddress: user.piAddress });
  } catch (err) {
    if (err.response?.status === 404) return res.json({ piBalance: 0, piAddress: user.piAddress });
    console.error('pi/wallet-balance error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Gagal mengambil saldo Pi' });
  }
}
