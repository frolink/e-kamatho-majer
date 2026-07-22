/**
 * lib/piClient.js
 * -----------------------------------------------------------------------
 * Wrapper tipis di atas axios untuk memanggil Pi Platform API resmi.
 * Referensi: https://github.com/pi-apps/pi-platform-docs
 *
 * File ini HANYA dipakai oleh api/pi.js. TIDAK boleh di-import dari
 * api/merchant.js, api/transfi.js, atau api/webhook.js — menjaga alur
 * Pi Payment dan alur TransFi/merchant tetap terpisah total.
 *
 * PENTING:
 *  - approve/complete/get-payment WAJIB dari server (pakai Server API Key),
 *    TIDAK BOLEH dari browser.
 *  - Header API key: "Authorization: Key <PI_API_KEY>"
 *  - Header verifikasi access token user: "Authorization: Bearer <accessToken>"
 *  - PI_SANDBOX=true berarti seluruh alur ini di Pi Testnet, konsisten
 *    dengan Pi.init({sandbox:true}) di frontend.
 * -----------------------------------------------------------------------
 */
const axios = require('axios');

const PI_API_KEY = process.env.PI_API_KEY;
const PLATFORM_BASE = process.env.PI_PLATFORM_BASE_URL || 'https://api.minepi.com';

function serverClient() {
  if (!PI_API_KEY) throw new Error('PI_API_KEY belum diset di environment variables');
  return axios.create({
    baseURL: PLATFORM_BASE,
    timeout: 20000,
    headers: { Authorization: `Key ${PI_API_KEY}` }
  });
}

async function verifyUserAccessToken(accessToken) {
  const res = await axios.get(`${PLATFORM_BASE}/v2/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000
  });
  console.log("PI /v2/me =", JSON.stringify(res.data, null, 2));
  return res.data;
}

async function getPayment(paymentId) {
  const res = await serverClient().get(`/v2/payments/${paymentId}`);
  return res.data;
}

async function approvePayment(paymentId) {
  const res = await serverClient().post(`/v2/payments/${paymentId}/approve`, null);
  return res.data;
}

async function completePayment(paymentId, txid) {
  const res = await serverClient().post(`/v2/payments/${paymentId}/complete`, { txid });
  return res.data;
}

async function cancelPayment(paymentId) {
  const res = await serverClient().post(`/v2/payments/${paymentId}/cancel`, null);
  return res.data;
}

module.exports = { verifyUserAccessToken, getPayment, approvePayment, completePayment, cancelPayment };
