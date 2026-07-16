/**
 * backend/middleware/cors.js
 * Helper CORS yang dipakai semua route — satu tempat untuk diubah.
 */
function setCors(res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin',  process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pi-Access-Token');
}

/**
 * Tangani preflight OPTIONS dan kembalikan true bila sudah selesai,
 * sehingga handler bisa langsung return.
 *
 * Contoh pemakaian di handler:
 *   if (handleCors(req, res)) return;
 */
function handleCors(req, res, methods = 'GET, POST, OPTIONS') {
  setCors(res, methods);
  if (req.method === 'OPTIONS') { res.writeHead(200).end(); return true; }
  return false;
}

module.exports = { setCors, handleCors };
