/**
 * POST /api/auth
 * Body: { accessToken, piAddress? }
 *
 * Verifikasi accessToken dari Pi.authenticate(), simpan/ambil user di
 * database. Murni login — tidak ada logika saldo atau transaksi.
 */
const piClient = require('../services/piClient');
const store    = require('../services/store');
const { handleCors } = require('../middleware/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { accessToken, piAddress } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: 'accessToken wajib diisi' });

    const piUser = await piClient.verifyUserAccessToken(accessToken);
    const user   = await store.upsertUser({
      uid: piUser.uid,
      username: piUser.username || 'pioneer',
      piAddress: piAddress || null,
    });

    return res.status(200).json({
      user: { uid: user.uid, username: user.username, piAddress: user.piAddress },
    });
  } catch (err) {
    console.error('[auth] error:', err.response?.data || err.message);
    return res.status(401).json({ error: 'Access token tidak valid' });
  }
};
