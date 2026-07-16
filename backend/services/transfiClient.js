/**
 * lib/transfiClient.js
 * -----------------------------------------------------------------------
 * Wrapper untuk TransFi API. Referensi resmi: https://docs.transfi.com
 * (Ramp/Offramp) dan https://ramp-docs.transfi.com (khusus produk Ramp,
 * yang mendukung cryptoTicker "PI" secara eksplisit di contoh webhook mereka).
 *
 * File ini dipakai oleh DUA endpoint yang berbeda tapi tetap saling lepas:
 *   - api/transfi.js  -> membuat order Offramp (Pi -> IDR) setelah Top Up
 *   - api/merchant.js -> membuat Payout (saldo Rupiah -> Bank/VA merchant terdaftar)
 * Tidak ada kode di sini yang bergantung pada lib/piClient.js atau
 * sebaliknya.
 *
 * AUTENTIKASI (dikonfirmasi dari dokumentasi resmi TransFi, halaman
 * "Getting started with TransFi"):
 *  - HTTP Basic Auth: gabungkan `username:password`, base64-encode, kirim
 *    sebagai header `Authorization: Basic <base64>`.
 *  - Kredensial diambil dari displai.transfi.com → Settings → API
 *    Credentials — SANDBOX dan PRODUCTION punya kredensial masing-masing
 *    yang terpisah, jangan disamakan.
 *  - Kredensial ini HANYA boleh hidup di server (env vars di Vercel),
 *    TIDAK BOLEH pernah masuk ke kode frontend/app.js.
 *
 * ⚠️ CATATAN JUJUR SOAL VERIFIKASI:
 * Base URL, mekanisme auth, dan endpoint `GET /v3/balance` (dipakai
 * `getBalance()` di bawah untuk tes koneksi) sudah dikonfirmasi LANGSUNG
 * dari dokumentasi resmi TransFi. Untuk endpoint lain di bawah (orders,
 * payouts, payment-methods, exchange-rates, supported-currencies) — path
 * v3 persisnya BELUM dikonfirmasi ulang satu-satu terhadap referensi resmi
 * (sebelumnya disusun mengikuti pola v2 & skema webhook publik mereka).
 * **Cocokkan ulang tiap endpoint ke "API Reference" di dashboard TransFi
 * kamu sebelum dipakai sungguhan** — jangan asumsikan path di file ini final.
 * -----------------------------------------------------------------------
 */
const axios = require('axios');
const crypto = require('crypto');

// Base URL resmi dari dokumentasi TransFi (BUKAN sandbox-api, tapi api-sandbox):
const TRANSFI_BASE_URL = process.env.TRANSFI_BASE_URL || 'https://api-sandbox.transfi.com';
const TRANSFI_USERNAME = process.env.TRANSFI_USERNAME; // dari displai.transfi.com -> Settings -> API Credentials
const TRANSFI_PASSWORD = process.env.TRANSFI_PASSWORD; // pasangan Basic Auth, beda untuk sandbox vs production
const TRANSFI_MID = process.env.TRANSFI_MID;
const TRANSFI_API_SECRET = process.env.TRANSFI_API_SECRET; // TERPISAH dari username/password di atas — dipakai HANYA untuk signing widget URL & verifikasi signature webhook, BUKAN untuk otentikasi request API biasa
const TRANSFI_WIDGET_BASE_URL = process.env.TRANSFI_WIDGET_BASE_URL || 'https://widget.transfi.com';

function authClient() {
  if (!TRANSFI_USERNAME || !TRANSFI_PASSWORD) {
    throw new Error('TRANSFI_USERNAME / TRANSFI_PASSWORD belum diset di environment variables');
  }
  const basic = Buffer.from(`${TRANSFI_USERNAME}:${TRANSFI_PASSWORD}`).toString('base64');
  return axios.create({
    baseURL: TRANSFI_BASE_URL,
    timeout: 20000,
    headers: {
      accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${basic}`,
      MID: TRANSFI_MID
    }
  });
}

/**
 * Endpoint resmi buat tes koneksi/kredensial — persis contoh "Test your
 * connection" di dokumentasi TransFi. 200 = kredensial benar, 401 = cek
 * lagi encoding/aktivasi kredensial di displai.transfi.com.
 */
async function getBalance() {
  const res = await authClient().get('/v3/balance');
  return res.data;
}

// ---------- ENDPOINT LAIN (lihat catatan verifikasi di header file) ----------
async function getSupportedCurrencies(direction = 'withdraw') {
  const res = await authClient().get('/v3/supported-currencies', { params: { direction } });
  return res.data;
}
async function getPaymentMethods(currency, direction = 'withdraw') {
  const res = await authClient().get('/v3/payment-methods', { params: { currency, direction } });
  return res.data;
}

// Cache in-memory sederhana (hidup selama instance serverless "hangat")
// supaya tidak boros kuota API gratis TransFi kalau banyak orang cek kurs
// dalam rentang waktu berdekatan. TTL pendek karena kurs kripto berubah cepat.
const PI_FIXED_RATE = 5000000; // 1 PI = Rp5.000.000

const rateCache = new Map();
const RATE_CACHE_TTL_MS = 30_000;

async function getExchangeRate({ amount }) {
  amount = Number(amount);

  return {
    success: true,
    cryptoPrice: PI_FIXED_RATE,
    receiveFiatAmount: Math.floor(amount * PI_FIXED_RATE),
    totalFee: 0,
    rateSource: "Ekamatho Fixed Rate"
  };
}

/**
 * Normalisasi & cocokkan dua nama untuk kebutuhan AML: nama pemilik
 * rekening tujuan harus konsisten dengan nama akun Pi (self-attested KYC
 * yang diinput user saat login). Pi Platform API publik TIDAK memberi
 * developer akses ke nama legal hasil KYC Pi Network (hanya `username`
 * lewat scope `username`) — jadi pencocokan otomatis penuh tetap jadi
 * tanggung jawab mesin KYC/compliance TransFi sendiri saat order diproses.
 * Fungsi ini adalah pengaman lapis pertama di sisi kita: mencegah nama
 * kosong/asal-asalan terkirim, dan menandai kecocokan kasar sebelum
 * diteruskan ke TransFi.
 */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // buang diakritik
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function namesMatch(nameA, nameB) {
  const a = normalizeName(nameA), b = normalizeName(nameB);
  if (!a || !b) return false;
  if (a === b) return true;
  // Kecocokan longgar: semua kata di nama pendek harus muncul di nama panjang
  // (menoleransi selisih gelar/nama tengah tanpa melonggarkan identitas inti).
  const shortWords = (a.length <= b.length ? a : b).split(' ');
  const longName = a.length <= b.length ? b : a;
  return shortWords.every(w => w.length > 1 && longName.includes(w));
}

/**
 * ⚠️ VERIFIKASI SEBELUM PRODUKSI — lihat catatan di atas file.
 * Membuat order Offramp: jual Pi, terima IDR ke saldo TransFi milik app.
 * customerOrderId dipakai sebagai referensi balik ke paymentId Pi kita,
 * supaya waktu webhook masuk kita tahu top up mana yang harus di-settle.
 */
async function createOfframpOrder({ customerOrderId, cryptoTicker = 'PI', depositAmount, withdrawCurrency = 'IDR', customerName }) {
  const res = await authClient().post('/v3/orders', {
    type: 'sell',
    depositCurrency: cryptoTicker,
    depositAmount,
    withdrawCurrency,
    customerOrderId,
    customerName: customerName || undefined
  });
  return res.data; // diharapkan berisi orderId + depositAddress (alamat TransFi utk menerima Pi)
}

/**
 * ⚠️ VERIFIKASI SEBELUM PRODUKSI.
 * Membuat Payout: kirim IDR dari saldo Rupiah TransFi ke rekening bank
 * atau Virtual Account merchant yang SUDAH TERDAFTAR. TransFi punya produk
 * "Payouts" terpisah dari Ramp/Offramp — cek API Reference "Payouts" di
 * dashboard kamu untuk field persis (recipient/beneficiary registration
 * biasanya harus dilakukan dulu sebelum bisa payout ke rekening tsb).
 *
 * CATATAN PENTING: paymentCode sengaja dibatasi ke 'bank_transfer' dan
 * 'virtual_account'. TransFi TIDAK terkonfirmasi mendukung "bayar dengan
 * scan QRIS milik pihak ketiga" (itu butuh lisensi QRIS acquiring/switching
 * terpisah, biasanya cuma dipegang bank/PJSP resmi) — jangan tambahkan
 * paymentCode 'qris' di sini tanpa verifikasi ulang ke TransFi.
 */
async function createPayout({ customerOrderId, amountIdr, currency = 'IDR', paymentCode, bankName, accountNumber, accountHolderName }) {
  if (!['bank_transfer', 'virtual_account'].includes(paymentCode)) {
    throw new Error(`paymentCode '${paymentCode}' tidak didukung untuk payout merchant (hanya bank_transfer/virtual_account)`);
  }
  const res = await authClient().post('/v3/payouts', {
    customerOrderId,
    amount: amountIdr,
    currency,
    paymentCode,
    beneficiary: { type: paymentCode, bankName, accountNumber, accountHolderName }
  });
  return res.data;
}

/**
 * ⚠️ VERIFIKASI SEBELUM PRODUKSI.
 * Tarik saldo Rupiah ke REKENING BANK PRIBADI milik user sendiri (bukan
 * merchant). Ini jalur paling sensitif secara AML: dana keluar dari
 * ekosistem app ke rekening bebas yang diinput user. Fungsi ini MEWAJIBKAN
 * namesMatch(piAccountName, accountHolderName) sudah dicek TRUE oleh
 * pemanggil (lihat api/withdraw.js) sebelum fungsi ini dipanggil — di sini
 * kita tetap validasi ulang sebagai lapis pertahanan kedua (defense in depth).
 */
async function createBankWithdrawal({ customerOrderId, amountIdr, currency = 'IDR', bankName, accountNumber, accountHolderName, piAccountName }) {
  if (!namesMatch(piAccountName, accountHolderName)) {
    throw new Error('AML: nama pemilik rekening tujuan tidak cocok dengan nama akun Pi');
  }
  const res = await authClient().post('/v3/payouts', {
    customerOrderId,
    amount: amountIdr,
    currency,
    paymentCode: 'bank_transfer',
    beneficiary: { type: 'bank', bankName, accountNumber, accountHolderName }
  });
  return res.data;
}

/**
 * Widget Ramp TransFi butuh URL yang di-sign HMAC-SHA256 pakai API secret
 * ketika membawa parameter sensitif (walletAddress, amount, dst).
 * Referensi: https://ramp-docs.transfi.com/docs/widget-integration
 */
function buildSignedWidgetUrl(params) {
  if (!TRANSFI_API_SECRET) throw new Error('TRANSFI_API_SECRET belum diset');
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', TRANSFI_API_SECRET).update(query).digest('hex');
  return `${TRANSFI_WIDGET_BASE_URL}?${query}&signature=${signature}`;
}

/**
 * Verifikasi signature webhook dari TransFi (server-to-server).
 * Sesuaikan nama header persis dengan pengaturan webhook di dashboard
 * TransFi kamu — pola di bawah HMAC SHA256 umum dipakai TransFi.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!TRANSFI_API_SECRET) return true; // tidak dikonfigurasi -> lewati (hanya untuk dev)
  const expected = crypto.createHmac('sha256', TRANSFI_API_SECRET).update(rawBody).digest('hex');
  return signatureHeader === expected;
}

module.exports = {
  getBalance,
  getSupportedCurrencies, getPaymentMethods, getExchangeRate,
  createOfframpOrder, createPayout, createBankWithdrawal,
  buildSignedWidgetUrl, verifyWebhookSignature,
  namesMatch
};
