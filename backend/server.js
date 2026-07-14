/**
 * backend/server.js
 * Entry point untuk local development (node server.js).
 * Di Vercel, setiap file di routes/ otomatis jadi serverless function via vercel.json.
 */
const http = require('http');
const url  = require('url');
const path = require('path');
const fs   = require('fs');

// Muat env dari root .env jika ada
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const routes = {
  '/api/auth':    require('./routes/auth'),
  '/api/health':  require('./routes/health'),
  '/api/merchant':require('./routes/merchant'),
  '/api/pi':      require('./routes/pi'),
  '/api/transfi': require('./routes/transfi'),
  '/api/wallet':  require('./routes/wallet'),
  '/api/webhook': require('./routes/webhook'),
  '/api/withdraw':require('./routes/withdraw'),
};

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url, true);
  const handler = routes[parsed.pathname];

  // Serve frontend statics untuk local dev
  if (!handler) {
    const frontendDir = path.join(__dirname, '..', 'frontend');
    let filePath = path.join(frontendDir, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext  = path.extname(filePath);
      const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.png':'image/png', '.ico':'image/x-icon' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // Parse body JSON untuk POST/PUT
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try { req.body = body ? JSON.parse(body) : {}; } catch (_) { req.body = {}; }
    req.query = parsed.query;
    await handler(req, res);
  });
});

server.listen(PORT, () => console.log(`[E-Kamatho] Server berjalan di http://localhost:${PORT}`));
