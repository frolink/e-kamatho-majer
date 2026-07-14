/**
 * backend/config/env.js
 * Validasi environment variables & ekspor konstanta konfigurasi.
 */
module.exports = {
  PI_API_KEY:           process.env.PI_API_KEY           || '',
  PI_SANDBOX:           process.env.PI_SANDBOX !== 'false',
  PI_PLATFORM_BASE_URL: process.env.PI_PLATFORM_BASE_URL || 'https://api.minepi.com',
  PI_HORIZON_URL:       process.env.PI_HORIZON_URL       || 'https://api.testnet.minepi.com',

  TRANSFI_BASE_URL:       process.env.TRANSFI_BASE_URL       || 'https://api-sandbox.transfi.com',
  TRANSFI_USERNAME:       process.env.TRANSFI_USERNAME        || '',
  TRANSFI_PASSWORD:       process.env.TRANSFI_PASSWORD        || '',
  TRANSFI_API_SECRET:     process.env.TRANSFI_API_SECRET      || '',
  TRANSFI_WIDGET_BASE_URL:process.env.TRANSFI_WIDGET_BASE_URL || 'https://widget.transfi.com',

  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  PORT:        process.env.PORT        || 3000,
};
