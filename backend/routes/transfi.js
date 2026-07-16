/**
 * /api/transfi — Utilitas internal seputar TransFi.
 *
 * Endpoint ini TIDAK diekspos ke pengguna secara langsung — hanya untuk
 * kebutuhan backend (cek kurs, status order, tes kredensial saat deploy).
 * Frontend bisa memanggil /api/convert?action=quote sebagai gantinya.
 *
 *   GET /api/transfi?action=test-connection
 *   GET /api/transfi?action=quote&amountPi=...
 *   GET /api/transfi?action=order-status&orderId=...
 */
const transfiClient  = require('../services/transfiClient');
const store          = require('../services/store');
const { handleCors } = require('../middleware/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action;
  try {
    if (action === 'test-connection') {
      const balance = await transfiClient.getBalance();
      return res.json({ connected: true, balance });
    }
    if (action === 'quote') {
      const amountPi = Number(req.query.amountPi);
      if (!amountPi || amountPi <= 0) return res.status(400).json({ error: 'amountPi wajib diisi' });
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
    const httpStatus = err.response?.status;
    console.error('[transfi] error:', err.response?.data || err.message);
    if (action === 'test-connection' && httpStatus === 401) {
      return res.status(401).json({
        connected: false,
        error: 'Kredensial TransFi salah. Cek TRANSFI_USERNAME/TRANSFI_PASSWORD di Vercel env.',
      });
    }
    return res.status(500).json({ error: 'Gagal mengambil data TransFi' });
  }
};
