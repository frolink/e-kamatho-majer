/**
 * /api/pi — Terima pembayaran Pi dari Pi Network SDK.
 *
 * Alur (Fase 1 dari pandangan pengguna: "Dompet Pi"):
 *   1. Frontend memanggil Pi.createPayment() → onReadyForServerApproval
 *   2. Frontend POST /api/pi?action=approve  → kita approve ke Pi Platform
 *   3. Frontend POST /api/pi?action=complete → Pi Platform konfirmasi txid,
 *      kita kredit piBalance user di ledger kita.
 *
 * Titik penting: setelah complete(), piBalance bertambah di ledger.
 * Konversi ke Rupiah adalah langkah TERPISAH yang dilakukan user secara
 * eksplisit via POST /api/convert. Dua langkah ini sengaja dipisah agar
 * pengguna bisa menyimpan Pi tanpa harus langsung konversi.
 *
 *   GET  /api/pi?action=balance&uid=...     → saldo Pi on-chain
 *   POST /api/pi?action=approve             body: { paymentId, uid }
 *   POST /api/pi?action=complete            body: { paymentId, txid, uid }
 */
const axios    = require('axios');
const piClient = require('../services/piClient');
const store    = require('../services/store');
const { handleCors } = require('../middleware/cors');

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.testnet.minepi.com';

// Cache sederhana untuk saldo on-chain supaya tidak membebani Horizon
const balanceCache = new Map();
const BALANCE_CACHE_TTL_MS = 10_000;

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const action = req.query.action;
  try {
    if (req.method === 'GET'  && action === 'balance') return await balance(req, res);
    if (req.method === 'POST' && action === 'approve') return await approve(req, res);
    if (req.method === 'POST' && action === 'complete') return await complete(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/pi' });
  } catch (err) {
    console.error('[pi] error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Terjadi kesalahan pada modul Pi' });
  }
};

// ── APPROVE ────────────────────────────────────────────────────────────────
async function approve(req, res) {
  const { paymentId, uid } = req.body || {};
  if (!paymentId || !uid) return res.status(400).json({ error: 'paymentId & uid wajib diisi' });

  const payment = await piClient.getPayment(paymentId);
  if (payment.user_uid !== uid) return res.status(403).json({ error: 'Payment tidak sesuai dengan user ini' });
  if (payment.status?.developer_approved) return res.json({ ok: true, alreadyApproved: true });

  await piClient.approvePayment(paymentId);
  await store.savePiPaymentApproved(paymentId, { paymentId, uid, amount: payment.amount, memo: payment.memo });
  return res.json({ ok: true });
}

// ── COMPLETE ───────────────────────────────────────────────────────────────
async function complete(req, res) {
  const { paymentId, txid, uid } = req.body || {};
  if (!paymentId || !txid || !uid) {
    return res.status(400).json({ error: 'paymentId, txid & uid wajib diisi' });
  }

  // Idempoten: kalau sudah pernah complete, kembalikan hasil yang sama
  const existing = await store.getPiPayment(paymentId);
  if (existing?.status === 'completed') {
    return res.json({
      ok: true,
      amountPi: existing.amount,
      piBalance: await store.getPiBalance(uid),
    });
  }

  const payment = await piClient.getPayment(paymentId);
  if (payment.user_uid !== uid) return res.status(403).json({ error: 'Payment tidak sesuai dengan user ini' });

  // Tandai selesai ke Pi Platform — setelah ini Pi resmi masuk ke wallet developer
  await piClient.completePayment(paymentId, txid);
  await store.savePiPaymentCompleted(paymentId, { paymentId, uid, amount: payment.amount, txid });

  // Kredit piBalance di ledger kita
  const newPiBalance = await store.creditPiBalance(uid, payment.amount);

  await store.addTransaction({
    uid,
    type: 'pi_topup',
    name: 'Top Up Pi',
    amountPi: payment.amount,
    txid,
    paymentId,
    note: 'Pi masuk ke Dompet Pi kamu',
  });

  return res.json({ ok: true, amountPi: payment.amount, piBalance: newPiBalance });
}

// ── BALANCE (saldo on-chain, bukan ledger) ─────────────────────────────────
async function balance(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });

  const user = await store.getUser(uid);
  if (!user?.piAddress) return res.json({ piBalance: 0, piAddress: null });

  const cached = balanceCache.get(user.piAddress);
  if (cached && Date.now() - cached.at < BALANCE_CACHE_TTL_MS) {
    return res.json({ piBalance: cached.piBalance, piAddress: user.piAddress, cached: true });
  }

  try {
    const acctRes = await axios.get(`${HORIZON_URL}/accounts/${user.piAddress}`, { timeout: 15000 });
    const native  = (acctRes.data.balances || []).find(b => b.asset_type === 'native');
    const piBalance = native ? Number(native.balance) : 0;
    balanceCache.set(user.piAddress, { at: Date.now(), piBalance });
    return res.json({ piBalance, piAddress: user.piAddress });
  } catch (err) {
    if (err.response?.status === 404) return res.json({ piBalance: 0, piAddress: user.piAddress });
    console.error('[pi/balance] error:', err.message);
    return res.status(500).json({ error: 'Gagal mengambil saldo Pi on-chain' });
  }
}
