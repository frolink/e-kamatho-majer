/**
 * /api/convert — Konversi Pi → Rupiah via TransFi Offramp.
 *
 * Fase 2 dari arsitektur Ekamatho.
 *
 * DARI SISI PENGGUNA input sangat sederhana:
 *   - Berapa Pi yang ingin dikonversi?
 *   - Selesai. TransFi yang mengurus sisanya.
 *
 * Pengguna TIDAK perlu mengisi bankName / accountNumber / accountHolderName
 * di sini. Detail rekening baru diminta saat user ingin MENARIK saldo
 * ke bank (POST /api/withdraw) — dan itu pun hanya sekali; setelah KYC
 * tersimpan, penarikan berikutnya lebih cepat.
 *
 * Alur di belakang layar:
 *   1. Cek piBalance cukup → debit piBalance (mencegah double-convert)
 *   2. Panggil TransFi createOfframpOrder(PI → IDR)
 *   3. Simpan order ke KV store
 *   4. Balas pengguna: "Konversi sedang diproses"
 *   5. TransFi → webhook fund_settled → /api/webhook menambah idrBalance
 *
 *   POST /api/convert?action=initiate   body: { uid, amountPi }
 *   GET  /api/convert?action=status&uid=...
 *   GET  /api/convert?action=quote&uid=...&amountPi=...
 */
const crypto       = require('crypto');
const transfiClient = require('../services/transfiClient');
const store         = require('../services/store');
const { handleCors } = require('../middleware/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const action = req.query.action;
  try {
    if (req.method === 'POST' && action === 'initiate') return await initiate(req, res);
    if (req.method === 'GET'  && action === 'status')   return await status(req, res);
    if (req.method === 'GET'  && action === 'quote')    return await quote(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/convert' });
  } catch (err) {
    console.error('[convert] error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Gagal memproses konversi' });
  }
};

// ── INITIATE ──────────────────────────────────────────────────────────────
async function initiate(req, res) {
  const { uid, amountPi } = req.body || {};

  if (!uid || !amountPi) {
    return res.status(400).json({ error: 'uid dan amountPi wajib diisi' });
  }
  if (Number(amountPi) <= 0) {
    return res.status(400).json({ error: 'Jumlah Pi harus lebih dari 0' });
  }

  const user = await store.getUser(uid);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

  // Cek saldo Pi mencukupi
  const piBalance = await store.getPiBalance(uid);
  if (piBalance < Number(amountPi)) {
    return res.status(400).json({
      error: `Saldo Pi tidak cukup. Saldo kamu: ${piBalance} π`,
    });
  }

  // Debit piBalance di muka — cegah double-convert saat retry
  await store.debitPiBalance(uid, amountPi);

  const convertId = 'CV-' + crypto.randomUUID();

  // Panggil TransFi Offramp — pengguna tidak perlu tahu detail ini
  let transfiOrderId = null;
  try {
    const order = await transfiClient.createOfframpOrder({
      customerOrderId:  convertId,
      cryptoTicker:     'PI',
      depositAmount:    amountPi,
      withdrawCurrency: 'IDR',
      fixedRate:       5000000,
      estimatedIdr:    Math.floor(Number(amountPi) * 5000000),
      customerName:     user.username || uid,
    });
    transfiOrderId = order.orderId || order.data?.orderId;

    await store.createTransfiOrder({
      orderId:         transfiOrderId,
      uid,
      convertId,
      depositAmount:   amountPi,
      depositCurrency: 'PI',
      withdrawCurrency:'IDR',
      fixedRate:       5000000,
      estimatedIdr:    Math.floor(Number(amountPi) * 5000000),
      status:          'initiated',
      raw:             order,
    });
  } catch (err) {
    // TransFi gagal → kembalikan piBalance, jangan hilangkan aset user
    await store.creditPiBalance(uid, amountPi);
    console.error('[convert] TransFi offramp gagal:', err.response?.data || err.message);
    return res.status(502).json({
      error: 'Konversi gagal diproses. Saldo Pi dikembalikan. Silakan coba lagi.',
    });
  }

  await store.addTransaction({
    uid,
    type:          'convert_pending',
    name:          'Konversi Pi → Rupiah',
    amountPi,
    convertId,
    transfiOrderId,
    note:          'Rupiah akan masuk setelah settlement (~beberapa menit)',
  });

  return res.json({
    convertId,
    amountPi,
    status:  'pending_settlement',
    message: 'Konversi sedang diproses. Saldo Rupiah kamu akan bertambah otomatis.',
  });
}

// ── STATUS ────────────────────────────────────────────────────────────────
async function status(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });

  const piBalance  = await store.getPiBalance(uid);
  const idrBalance = await store.getIdrBalance(uid);
  const kycStatus  = await store.getKycStatus(uid);

  return res.json({ piBalance, idrBalance, kycStatus });
}

// ── QUOTE (estimasi kurs sebelum konversi) ────────────────────────────────
async function quote(req, res) {
  const amountPi = Number(req.query.amountPi);
  if (!amountPi || amountPi <= 0) {
    return res.status(400).json({ error: 'amountPi wajib diisi dan lebih dari 0' });
  }
  const rate = await transfiClient.getExchangeRate({
    cryptoTicker: 'PI',
    fiatTicker:   'IDR',
    amount:       amountPi,
  });
  return res.json(rate);
}
