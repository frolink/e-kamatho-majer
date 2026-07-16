/**
 * GET /api/health
 * Dipakai untuk cek apakah server berjalan (uptime check / CI).
 */
const { handleCors } = require('../middleware/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res, 'GET, OPTIONS')) return;
  return res.status(200).json({ status: 'ok', ts: new Date().toISOString() });
};
