/**
 * /api/wallet — Saldo & riwayat transaksi pengguna.
 *
 * Endpoint ini adalah "jendela" yang dilihat frontend untuk menampilkan:
 *   - Dompet Pi   : piBalance
 *   - Dompet Rupiah: idrBalance
 *   - Riwayat semua transaksi
 *
 * Tidak memanggil Pi Platform API maupun TransFi API secara langsung —
 * murni membaca ledger dari store.js yang diisi oleh route lain.
 *
 *   GET /api/wallet?action=balance&uid=...
 *   GET /api/wallet?action=history&uid=...
 */
const store          = require('../services/store');
const { handleCors } = require('../middleware/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, action } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });

  try {
    if (action === 'balance') {
      const piBalance  = await store.getPiBalance(uid);
      const idrBalance = await store.getIdrBalance(uid);
      return res.json({ piBalance, idrBalance });
    }
    if (action === 'history') {
      const transactions = await store.listTransactions(uid);
      return res.json({ transactions });
    }
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/wallet' });
  } catch (err) {
    console.error('[wallet] error:', err.message);
    return res.status(500).json({ error: 'Gagal mengambil data wallet' });
  }
};
