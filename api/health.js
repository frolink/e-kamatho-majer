/**
 * GET /api/health
 * Endpoint sederhana untuk cek backend hidup.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  return res.status(200).json({
    ok: true,
    network: process.env.PI_SANDBOX === 'false' ? 'mainnet' : 'testnet',
    time: new Date().toISOString()
  });
};
