/**
 * /api/merchant — Bayar merchant dari Dompet Rupiah.
 *
 * Fase 5 dari arsitektur Ekamatho. Merchant menerima pembayaran dari
 * saldo Rupiah pengguna — bukan langsung dari Pi. TransFi menangani
 * transfer IDR ke rekening bank/VA merchant di belakang layar.
 *
 * Dari sisi pengguna: pilih merchant → masukkan nominal → bayar.
 * Tidak ada Pi SDK, tidak ada API Key, tidak ada istilah teknis.
 *
 *   GET  /api/merchant?action=list&uid=...
 *   POST /api/merchant?action=register
 *        body: { uid, name, category, paymentCode, bankName, accountNumber, accountHolderName }
 *   POST /api/merchant?action=payout
 *        body: { uid, merchantId, amountIdr }
 */
const crypto        = require('crypto');
const transfiClient  = require('../services/transfiClient');
const store          = require('../services/store');
const { handleCors } = require('../middleware/cors');

const MIN_PAYMENT_IDR = 1_000;

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const action = req.query.action;
  try {
    if (req.method === 'GET'  && action === 'list')     return await list(req, res);
    if (req.method === 'POST' && action === 'register') return await register(req, res);
    if (req.method === 'POST' && action === 'payout')   return await payout(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/merchant' });
  } catch (err) {
    console.error('[merchant] error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Terjadi kesalahan pada modul Merchant' });
  }
};

// ── LIST ──────────────────────────────────────────────────────────────────
async function list(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });
  const merchants = await store.listMerchants(uid);
  return res.json({ merchants });
}

// ── REGISTER ──────────────────────────────────────────────────────────────
async function register(req, res) {
  const { uid, name, category, paymentCode, bankName, accountNumber, accountHolderName } = req.body || {};
  if (!uid || !name || !paymentCode || !bankName || !accountNumber || !accountHolderName) {
    return res.status(400).json({
      error: 'name, paymentCode, bankName, accountNumber, accountHolderName wajib diisi',
    });
  }
  if (!['bank_transfer', 'virtual_account'].includes(paymentCode)) {
    return res.status(400).json({ error: 'paymentCode harus bank_transfer atau virtual_account' });
  }
  const merchantId = 'm_' + crypto.randomUUID();
  const merchant   = await store.createMerchant({
    merchantId, scope: 'personal', ownerUid: uid,
    name, category: category || 'Umum', paymentCode, bankName, accountNumber, accountHolderName,
  });
  return res.json({ merchant });
}

// ── PAYOUT ────────────────────────────────────────────────────────────────
async function payout(req, res) {
  const { uid, merchantId, amountIdr } = req.body || {};
  if (!uid || !merchantId || !amountIdr) {
    return res.status(400).json({ error: 'uid, merchantId & amountIdr wajib diisi' });
  }
  if (Number(amountIdr) < MIN_PAYMENT_IDR) {
    return res.status(400).json({ error: `Minimum pembayaran Rp${MIN_PAYMENT_IDR.toLocaleString('id')}` });
  }

  const merchant = await store.getMerchant(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Merchant tidak ditemukan' });
  if (merchant.scope === 'personal' && merchant.ownerUid !== uid) {
    return res.status(403).json({ error: 'Merchant ini bukan milik kamu' });
  }

  const idrBalance = await store.getIdrBalance(uid);
  if (Number(amountIdr) > idrBalance) {
    return res.status(400).json({
      error: `Saldo Rupiah tidak cukup (Rp${idrBalance.toLocaleString('id')}). Konversi Pi dulu.`,
    });
  }

  const payoutId = 'PO-' + crypto.randomUUID();

  // Debit dulu — cegah double-spend
  await store.debitIdrBalance(uid, amountIdr);
  await store.createPayout({ payoutId, uid, merchantId, amountIdr, status: 'pending' });

  try {
    const payoutRes = await transfiClient.createPayout({
      customerOrderId: payoutId,
      amountIdr,
      paymentCode:        merchant.paymentCode,
      bankName:           merchant.bankName,
      accountNumber:      merchant.accountNumber,
      accountHolderName:  merchant.accountHolderName,
    });
    await store.updatePayout(payoutId, {
      status:     'submitted',
      transfiRef: payoutRes.orderId || payoutRes.data?.orderId,
      raw:        payoutRes,
    });
  } catch (err) {
    // Gagal → kembalikan saldo
    await store.creditIdrBalance(uid, amountIdr);
    await store.updatePayout(payoutId, { status: 'failed', errorMessage: err.message });
    console.error('[merchant/payout] TransFi gagal:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Pembayaran gagal diproses. Saldo dikembalikan. Coba lagi.' });
  }

  await store.addTransaction({
    uid,
    type:     'merchant',
    name:     `Bayar ${merchant.name}`,
    amountIdr,
    payoutId,
    merchantId,
  });

  return res.json({
    payoutId,
    amountIdr,
    idrBalance: await store.getIdrBalance(uid),
    message: `Pembayaran ke ${merchant.name} berhasil diproses.`,
  });
}
