/**
 * /api/transfi — utilitas seputar TransFi Offramp: cek kurs Pi->IDR dan
 * status order konversi. Order Offramp itu sendiri DIBUAT dari api/pi.js
 * (langsung setelah Pi payment complete) — file ini untuk query/inquiry,
 * bukan untuk trigger payout merchant (itu tugas api/merchant.js).
 *
 *   GET /api/transfi?action=quote&amountPi=...
 *   GET /api/transfi?action=order-status&orderId=...
 *   GET /api/transfi?action=test-connection   -> cek TRANSFI_USERNAME/PASSWORD benar
 */
const transfiClient = require('../backend/services/transfiClient');
const store = require('../backend/services/store');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action;
  try {
    if (action === 'test-connection') {
      // Persis "Test your connection" di dokumentasi TransFi: GET /v3/balance.
      // 200 -> kredensial benar. 401 dari TransFi akan tertangkap di catch
      // di bawah dan diteruskan sebagai error yang jelas.
      const balance = await transfiClient.getBalance();
      return res.json({ connected: true, balance });
    }
    if (action === 'quote') {
      const amountPi = Number(req.query.amountPi);
      if (!amountPi) return res.status(400).json({ error: 'amountPi wajib diisi' });
      const rate = await transfiClient.getExchangeRate({ cryptoTicker: 'PI', fiatTicker: 'IDR', amount: amountPi });
      return res.json(rate);
    }
    if (action === 'order-status') {
      const { orderId } = req.query;
      if (!orderId) return res.status(400).json({ error: 'orderId wajib diisi' });
      const order = await store.getTransfiOrder(orderId);
      if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
      return res.json({ order });
    }
    return res.status(400).json({ error: 'Aksi tidak dikenal untuk /api/transfi' });
  } catch (err) {
    const status = err.response?.status;
    console.error('api/transfi error:', err.response?.data || err.message);
    if (req.query.action === 'test-connection' && status === 401) {
      return res.status(401).json({
        connected: false,
        error: 'Kredensial TransFi salah. Cek TRANSFI_USERNAME/TRANSFI_PASSWORD dan pastikan sudah aktif di displai.transfi.com.'
      });
    }
    return res.status(500).json({ error: 'Gagal mengambil data TransFi' });
  }
};
