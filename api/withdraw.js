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
