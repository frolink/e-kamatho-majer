/**
 * /api/wallet — dua saldo: piBalance & idrBalance.
 *
 *   GET /api/wallet?action=balance&uid=...
 *   GET /api/wallet?action=history&uid=...
 */
const store = require('../backend/services/store');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { uid, action } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });

  if (action === 'balance') {
    const piBalance  = await store.getPiBalance(uid);
    const idrBalance = await store.getIdrBalance(uid);
    const kycStatus  = await store.getKycStatus(uid);
    console.log('[wallet] balance', uid, { piBalance, idrBalance });
    return res.json({ piBalance, idrBalance, kycStatus });
  }
  if (action === 'history') {
    return res.json({ transactions: await store.listTransactions(uid) });
  }
  return res.status(400).json({ error: 'Aksi tidak dikenal' });
};
