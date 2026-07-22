/**
 * POST /api/auth
 * Body: { accessToken, piAddress? }
 *
 * Verifikasi accessToken hasil Pi.authenticate() langsung ke Pi Platform
 * API, lalu simpan/ambil user di database sendiri. File ini murni LOGIN —
 * tidak ada logika Top Up (pi.js/transfi.js) atau Merchant (merchant.js).
 */
const piClient = require('../backend/services/piClient');
const store = require('../backend/services/store');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { accessToken, piAddress } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: 'accessToken wajib diisi' });

    const piUser = await piClient.verifyUserAccessToken(accessToken);
    console.log("PI USER =", piUser);
    const user = await store.upsertUser({
      uid: piUser.uid,
      username: piUser.username || 'pioneer',
      piAddress: piAddress || null
    });

    return res.status(200).json({
      user: { uid: user.uid, username: user.username, piAddress: user.piAddress }
    });
  } catch (err) {
    console.error('api/auth error:', err.response?.data || err.message);
    return res.status(401).json({ error: 'Access token tidak valid' });
  }
};
