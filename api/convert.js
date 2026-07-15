/**
 * /api/convert — Konversi Pi → Rupiah via TransFi Offramp.
 *
 * Ini satu-satunya pintu masuk dari aset kripto (Pi) ke fiat (IDR).
 *
 * Gate AML sebelum offramp:
 *   1. Cek status KYC Pi user (dari Pi Platform API)
 *   2. Cek rekening bank sudah diverifikasi via KYC TransFi
 *   3. Cocokkan nama Pi KYC dengan nama pemilik rekening bank
 *   4. Jika lolos → jalankan TransFi Offramp (debit piBalance, nanti idrBalance
 *      bertambah saat webhook TransFi settle tiba)
 *   5. Set kycStatus.verifiedForIdr = true di store
 *
 *   POST /api/convert?action=initiate
 *   body: { uid, amountPi, piKycName, bankName, accountNumber, accountHolderName }
 *
 *   GET /api/convert?action=status&uid=...
 */
const crypto = require('crypto');
const transfiClient = require('../backend/services/transfiClient');
const piClient      = require('../backend/services/piClient');
const store         = require('../backend/services/store');
const { namesMatch } = require('../backend/utils/nameMatch');

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
    if (req.method === 'POST' && action === 'initiate') return await initiate(req, res);
    if (req.method === 'GET'  && action === 'status')   return await status(req, res);
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/convert' });
  } catch (err) {
    console.error('api/convert error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Gagal memproses konversi' });
  }
};

async function initiate(req, res) {
  const { uid, amountPi, piKycName, bankName, accountNumber, accountHolderName } = req.body || {};
  if (!uid || !amountPi || !piKycName || !bankName || !accountNumber || !accountHolderName) {
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  }
  if (Number(amountPi) <= 0) return res.status(400).json({ error: 'Jumlah Pi harus lebih dari 0' });

  const user = await store.getUser(uid);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

  // ── Cek piBalance mencukupi ───────────────────────────────────────────────
  const piBalance = await store.getPiBalance(uid);
  if (piBalance < Number(amountPi)) {
    return res.status(400).json({ error: 'Saldo Pi tidak cukup untuk dikonversi' });
  }

  // ── Cek kycStatus: kalau sudah verifiedForIdr dan rekening sama, skip nama check ──
  const kycStatus = await store.getKycStatus(uid);
  const sameAccount = kycStatus.verifiedForIdr
    && kycStatus.accountNumber === accountNumber
    && kycStatus.bankName      === bankName;

  if (!sameAccount) {
    // ── GATE 1: Pi KYC status ─────────────────────────────────────────────
    let piUserKycPassed = false;
    try {
      const accessToken = req.headers['x-pi-access-token'];
      if (accessToken) {
        const me = await piClient.getMe(accessToken);
        piUserKycPassed = me?.kyc_verified === true || me?.roles?.includes('kyc_verified') || false;
      }
    } catch (e) {
      console.warn('[convert] Gagal cek Pi KYC status:', e.message);
      // Jangan blokir jika gagal cek — log saja, lanjutkan ke pengecekan nama
    }

    // ── GATE 2 & 3: Pencocokan nama AML ──────────────────────────────────
    if (!namesMatch(piKycName, accountHolderName)) {
      return res.status(400).json({
        error: 'Nama pemilik akun Pi harus sesuai dengan nama pemilik rekening bank untuk memenuhi kebijakan KYC dan AML.',
        amlViolation: true,
      });
    }
  }

  // ── Debit piBalance di muka (cegah double-spend) ──────────────────────────
  await store.debitPiBalance(uid, amountPi);

  const convertId = 'CV-' + crypto.randomUUID();

  // ── Jalankan TransFi Offramp ──────────────────────────────────────────────
  let transfiOrderId = null;
  try {
    const order = await transfiClient.createOfframpOrder({
      customerOrderId: convertId,
      cryptoTicker:    'PI',
      depositAmount:   amountPi,
      withdrawCurrency:'IDR',
      customerName:    accountHolderName,
    });
    transfiOrderId = order.orderId || order.data?.orderId;
    await store.createTransfiOrder({
      orderId:         transfiOrderId,
      uid,
      convertId,
      depositAmount:   amountPi,
      depositCurrency: 'PI',
      withdrawCurrency:'IDR',
      bankName, accountNumber, accountHolderName,
      status: 'initiated',
      raw: order,
    });
  } catch (err) {
    // TransFi gagal — kembalikan piBalance
    await store.creditPiBalance(uid, amountPi);
    console.error('[convert] TransFi offramp gagal:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Konversi ke TransFi gagal. Saldo Pi dikembalikan. Coba lagi.' });
  }

  // ── Set KYC Verified ──────────────────────────────────────────────────────
  await store.setKycVerified(uid, { bankName, accountNumber, accountHolderName, piName: piKycName });

  await store.addTransaction({
    uid, type: 'convert_pi', name: 'Konversi Pi → Rupiah',
    badge: 'TransFi Offramp', amountPi, convertId, transfiOrderId,
    note: 'IDR masuk setelah TransFi settle',
  });

  return res.json({
    convertId,
    transfiOrderId,
    amountPi,
    status: 'pending_settlement',
    message: 'Konversi dimulai. Saldo Rupiah akan bertambah setelah TransFi mengonfirmasi settlement.',
  });
}

async function status(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });
  const kycStatus  = await store.getKycStatus(uid);
  const piBalance  = await store.getPiBalance(uid);
  const idrBalance = await store.getIdrBalance(uid);
  return res.json({ kycStatus, piBalance, idrBalance });
}
