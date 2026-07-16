/**
 * /api/withdraw — Tarik saldo Rupiah ke rekening bank pribadi user.
 *
 * Fase 4 dari arsitektur Ekamatho. Baru DI SINILAH:
 *   1. Detail rekening dikumpulkan (bankName, accountNumber, accountHolderName)
 *   2. KYC divalidasi: nama rekening HARUS cocok dengan nama akun Pi (AML)
 *   3. Setelah lolos, idrBalance didebit & TransFi Payout dieksekusi
 *
 * Pengguna hanya mengisi rekening SEKALI — setelah terverifikasi, data KYC
 * disimpan dan penarikan berikutnya langsung diproses tanpa isi ulang.
 *
 *   POST /api/withdraw?action=submit
 *   body: { uid, amountIdr, bankName, accountNumber, accountHolderName, piAccountName }
 *
 *   GET  /api/withdraw?action=kyc-status&uid=...
 */
const crypto        = require('crypto');
const transfiClient  = require('../services/transfiClient');
const store          = require('../services/store');
const { handleCors } = require('../middleware/cors');

const MIN_WITHDRAW_IDR = 10_000;

module.exports = async (req, res) => {
  if (handleCors(req, res, 'GET, POST, OPTIONS')) return;

  const action = req.query.action;
  try {
    if (req.method === 'POST' && action === 'submit')      return await submit(req, res);
    if (req.method === 'GET'  && action === 'kyc-status')  return await kycStatus(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/withdraw' });
  } catch (err) {
    console.error('[withdraw] error:', err.message);
    return res.status(400).json({ error: err.message || 'Gagal memproses penarikan' });
  }
};

// ── SUBMIT ────────────────────────────────────────────────────────────────
async function submit(req, res) {
  const { uid, amountIdr, bankName, accountNumber, accountHolderName, piAccountName } = req.body || {};

  if (!uid || !amountIdr || !bankName || !accountNumber || !accountHolderName || !piAccountName) {
    return res.status(400).json({
      error: 'Semua field wajib: amountIdr, bankName, accountNumber, accountHolderName, piAccountName',
    });
  }
  if (Number(amountIdr) < MIN_WITHDRAW_IDR) {
    return res.status(400).json({ error: `Minimum penarikan Rp${MIN_WITHDRAW_IDR.toLocaleString('id')}` });
  }

  // ── GATE AML: nama rekening HARUS sama dengan nama akun Pi ──────────
  // Ini satu-satunya titik di mana dana keluar ke rekening pihak luar.
  // Pengecekan dilakukan di sini (bukan saat login) agar berlaku per-tarik.
  if (!transfiClient.namesMatch(piAccountName, accountHolderName)) {
    return res.status(400).json({
      error: 'Nama pemilik rekening harus sama dengan nama akun Pi kamu. Penarikan ditolak (AML).',
      amlViolation: true,
    });
  }

  const idrBalance = await store.getIdrBalance(uid);
  if (Number(amountIdr) > idrBalance) {
    return res.status(400).json({
      error: `Saldo Rupiah tidak cukup. Saldo kamu: Rp${idrBalance.toLocaleString('id')}`,
    });
  }

  const withdrawalId = 'WD-' + crypto.randomUUID();

  // Debit dulu di ledger — cegah double-spend saat retry
  await store.debitIdrBalance(uid, amountIdr);
  await store.createWithdrawal({ withdrawalId, uid, amountIdr, bankName, accountNumber, accountHolderName, piAccountName, status: 'pending' });

  // Simpan/perbarui data KYC setelah lolos AML
  await store.setKycVerified(uid, { bankName, accountNumber, accountHolderName, piName: piAccountName });

  try {
    const payoutRes = await transfiClient.createBankWithdrawal({
      customerOrderId: withdrawalId,
      amountIdr,
      bankName,
      accountNumber,
      accountHolderName,
      piAccountName,
    });
    await store.updateWithdrawal(withdrawalId, {
      status:     'submitted',
      transfiRef: payoutRes.orderId || payoutRes.data?.orderId,
      raw:        payoutRes,
    });
  } catch (err) {
    // TransFi gagal setelah saldo terlanjur didebit → kembalikan saldo
    await store.creditIdrBalance(uid, amountIdr);
    await store.updateWithdrawal(withdrawalId, { status: 'failed', errorMessage: err.message });
    console.error('[withdraw] TransFi payout gagal:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Penarikan gagal diproses. Saldo dikembalikan. Coba lagi.' });
  }

  await store.addTransaction({
    uid,
    type:     'withdraw',
    name:     `Tarik ke ${bankName}`,
    amountIdr,
    withdrawalId,
    note:     'TransFi Payout ke rekening pribadi',
  });

  return res.json({
    withdrawalId,
    amountIdr,
    idrBalance: await store.getIdrBalance(uid),
    message: 'Penarikan diproses. Dana akan masuk ke rekening kamu dalam 1–2 hari kerja.',
  });
}

// ── KYC STATUS (untuk pra-isi form jika sudah pernah KYC) ─────────────────
async function kycStatus(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });
  const kyc = await store.getKycStatus(uid);
  return res.json({ kycStatus: kyc });
}
