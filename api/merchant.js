/**
 * /api/merchant — Bayar Merchant dari Saldo Rupiah via TransFi Payout.
 *
 * Flow v2 (TIDAK ada Pi SDK):
 *   idrBalance → debit → TransFi Payout → Rekening Merchant
 *
 *   GET  /api/merchant?action=list&uid=...
 *   POST /api/merchant?action=register   body: { uid, name, category, paymentCode, bankName, accountNumber, accountHolderName }
 *   POST /api/merchant?action=payout     body: { uid, merchantId, amountIdr }
 */
const crypto = require('crypto');
const transfiClient = require('../backend/services/transfiClient');
const store = require('../backend/services/store');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query.action;
  try {
    if (req.method === 'GET'  && action === 'list')     return await listMerchants(req, res);
    if (req.method === 'POST' && action === 'register') return await registerMerchant(req, res);
    if (req.method === 'POST' && action === 'payout')   return await payout(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal' });
  } catch (err) {
    console.error('api/merchant error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Terjadi kesalahan pada modul Merchant' });
  }
};

async function listMerchants(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });
  return res.json({ merchants: await store.listMerchants(uid) });
}

async function registerMerchant(req, res) {
  const { uid, name, category, paymentCode, bankName, accountNumber, accountHolderName } = req.body || {};
  if (!uid || !name || !paymentCode || !bankName || !accountNumber || !accountHolderName) {
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  }
  if (!['bank_transfer','virtual_account'].includes(paymentCode)) {
    return res.status(400).json({ error: 'paymentCode harus bank_transfer atau virtual_account' });
  }
  const merchantId = 'm_' + crypto.randomUUID();
  const merchant   = await store.createMerchant({ merchantId, scope:'personal', ownerUid:uid, name, category: category||'Umum', paymentCode, bankName, accountNumber, accountHolderName });
  return res.json({ merchant });
}

async function payout(req, res) {
  const { uid, merchantId, amountIdr } = req.body || {};
  if (!uid || !merchantId || !amountIdr) return res.status(400).json({ error: 'uid, merchantId & amountIdr wajib diisi' });
  if (amountIdr < 1000) return res.status(400).json({ error: 'Jumlah minimal Rp1.000' });

  const merchant = await store.getMerchant(merchantId);
  if (!merchant) return res.status(400).json({ error: 'Merchant tidak ditemukan' });
  if (merchant.scope === 'personal' && merchant.ownerUid !== uid) {
    return res.status(403).json({ error: 'Merchant ini bukan milik kamu' });
  }

  // Cek idrBalance (bukan piBalance)
  const idrBalance = await store.getIdrBalance(uid);
  if (amountIdr > idrBalance) return res.status(400).json({ error: 'Saldo Rupiah tidak cukup. Lakukan konversi Pi → Rupiah terlebih dahulu.' });

  const payoutId = 'PO-' + crypto.randomUUID();

  // Debit idrBalance di muka, simpan pending
  await store.debitIdrBalance(uid, amountIdr);
  await store.createPayout({ payoutId, uid, merchantId, amountIdr, status: 'pending' });

  try {
    const payoutRes = await transfiClient.createPayout({
      customerOrderId: payoutId,
      amountIdr,
      paymentCode:       merchant.paymentCode,
      bankName:          merchant.bankName,
      accountNumber:     merchant.accountNumber,
      accountHolderName: merchant.accountHolderName,
    });
    await store.updatePayout(payoutId, { status:'submitted', transfiRef: payoutRes.orderId || payoutRes.data?.orderId, raw: payoutRes });
  } catch (err) {
    console.error('[merchant/payout] TransFi gagal:', err.response?.data || err.message);
    await store.creditIdrBalance(uid, amountIdr);
    await store.updatePayout(payoutId, { status:'failed', errorMessage: err.message });
    return res.status(502).json({ error: 'Payout ke TransFi gagal, saldo dikembalikan.' });
  }

  await store.addTransaction({ uid, type:'merchant', name:'Bayar '+merchant.name, badge:'TransFi Payout', amountIdr, payoutId });

  return res.json({ payoutId, amountIdr, newIdrBalance: await store.getIdrBalance(uid) });
}
