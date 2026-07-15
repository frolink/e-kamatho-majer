/**
 * /api/wallet — saldo Rupiah (hasil settle TransFi) & riwayat transaksi.
 * Tidak memanggil Pi Platform API maupun TransFi API secara langsung —
 * murni membaca ledger di store.js yang diisi oleh pi.js (via webhook)
 * dan merchant.js.
 *
 *   GET /api/wallet?action=balance&uid=...
 *   GET /api/wallet?action=history&uid=...
 */
const store = require('../backend/services/store');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { uid, action } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });

  if (action === 'balance') {
    console.log("Wallet balance:", uid, await store.getAppBalance(uid));
    return res.json({ appBalance: await store.getAppBalance(uid) });
  }
  if (action === 'history') {
    return res.json({ transactions: await store.listTransactions(uid) });
  }
  return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/wallet' });
};
