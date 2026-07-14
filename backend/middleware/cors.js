/**
 * backend/middleware/cors.js
 * Helper CORS — dipakai di semua route handler.
 */
const { CORS_ORIGIN } = require('../config/env');

function setCors(res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin',  CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = { setCors };
