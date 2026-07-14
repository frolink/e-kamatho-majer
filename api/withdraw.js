/**
 * /api/withdraw — Tarik saldo Rupiah ke REKENING BANK PRIBADI user (bebas,
 * bukan daftar merchant tetap). Ini modul TERPISAH dari api/merchant.js:
 *
 *   - api/merchant.js -> bayar BISNIS pihak ketiga (warung/Indomaret dll),
 *     nama penerima MEMANG berbeda dari nama user, itu wajar.
 *   - api/withdraw.js -> tarik dana milik user KEMBALI ke rekening user
 *     sendiri. Di sinilah AML berlaku: nama pemilik rekening tujuan WAJIB
 *     sama dengan nama akun Pi user, dicek SAAT PENARIKAN (bukan saat
 *     login) — supaya tidak ada dana yang keluar ke rekening orang lain
 *     memakai identitas Pi yang berbeda (indikasi pencucian uang).
 *
 *   POST /api/withdraw?action=submit
 *   body: { uid, piAccountName, bankName, accountNumber, accountHolderName, amountIdr }
 */
const crypto = require('crypto');
const transfiClient = require('../backend/services/transfiClient');
const store = require('../backend/services/store');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' || req.query.action !== 'submit') {
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/withdraw' });
  }

  try {
    const { uid, piAccountName, bankName, accountNumber, accountHolderName, amountIdr } = req.body || {};
    if (!uid || !piAccountName || !bankName || !accountNumber || !accountHolderName || !amountIdr) {
      return res.status(400).json({ error: 'Semua field wajib diisi: piAccountName, bankName, accountNumber, accountHolderName, amountIdr' });
    }
    if (amountIdr < 10000) return res.status(400).json({ error: 'Jumlah penarikan minimal Rp10.000' });

    // ---- AML GATE: nama rekening tujuan HARUS sama dengan nama akun Pi ----
    // Dicek di sini, saat penarikan — bukan saat login — sesuai kebutuhan
    // Anda. Kalau tidak cocok, permintaan ditolak SEBELUM saldo disentuh
    // sama sekali.
    if (!transfiClient.namesMatch(piAccountName, accountHolderName)) {
      return res.status(400).json({
        error: 'Nama pemilik rekening tujuan harus sama dengan nama akun Pi kamu. Penarikan ditolak untuk mencegah pencucian uang.'
      });
    }

    const currentBalance = await store.getAppBalance(uid);
    if (amountIdr > currentBalance) return res.status(400).json({ error: 'Saldo Rupiah tidak cukup' });

    const withdrawalId = 'WD-' + crypto.randomUUID();

    // Debit dulu di ledger (cegah double-spend saat retry), simpan pending,
    // baru panggil TransFi.
    await store.debitAppBalance(uid, amountIdr);
    await store.createWithdrawal({
      withdrawalId, uid, amountIdr, bankName, accountNumber, accountHolderName, piAccountName,
      status: 'pending'
    });

    try {
      const payoutRes = await transfiClient.createBankWithdrawal({
        customerOrderId: withdrawalId,
        amountIdr,
        bankName, accountNumber, accountHolderName, piAccountName
      });
      await store.updateWithdrawal(withdrawalId, {
        status: 'submitted', transfiRef: payoutRes.orderId || payoutRes.data?.orderId, raw: payoutRes
      });
    } catch (err) {
      // Gagal dikirim ke TransFi setelah saldo terlanjur didebit -> kembalikan saldo.
      console.error('Gagal membuat penarikan bank via TransFi:', err.response?.data || err.message);
      await store.creditAppBalance(uid, amountIdr);
      await store.updateWithdrawal(withdrawalId, { status: 'failed', errorMessage: err.message });
      return res.status(502).json({ error: 'Penarikan ke TransFi gagal, saldo dikembalikan. Coba lagi.' });
    }

    await store.addTransaction({
      uid, type: 'withdraw', name: 'Tarik ke ' + bankName, badge: 'TransFi Withdrawal',
      amountIdr, withdrawalId
    });

    return res.json({ withdrawalId, amountIdr, newAppBalance: await store.getAppBalance(uid) });
  } catch (err) {
    console.error('api/withdraw error:', err.message);
    return res.status(400).json({ error: err.message || 'Gagal memproses penarikan' });
  }
};
