/**
 * backend/server.js
 * Entry point untuk local development: node backend/server.js
 *
 * Di Vercel, setiap file di backend/routes/ otomatis jadi serverless
 * function via pemetaan di vercel.json. File ini hanya dipakai saat
 * menjalankan server lokal.
 */
const http = require('http');
const url  = require('url');
const path = require('path');
const fs   = require('fs');

try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const routes = {
  '/api/auth':     require('./routes/auth'),
  '/api/health':   require('./routes/health'),
  '/api/pi':       require('./routes/pi'),
  '/api/convert':  require('./routes/convert'),
  '/api/wallet':   require('./routes/wallet'),
  '/api/merchant': require('./routes/merchant'),
  '/api/withdraw': require('./routes/withdraw'),
  '/api/transfi':  require('./routes/transfi'),
  '/api/webhook':  require('./routes/webhook'),
};

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url, true);
  const handler = routes[parsed.pathname];

  // Sajikan frontend statics untuk local dev
  if (!handler) {
    const frontendDir = path.join(__dirname, '..', 'frontend');
    const filePath = path.join(frontendDir, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext  = path.extname(filePath);
      const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
                     '.png':'image/png', '.ico':'image/x-icon' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try { req.body = body ? JSON.parse(body) : {}; } catch (_) { req.body = {}; }
    req.query = parsed.query;
    res.statusCode = 200;
    res.status = function(code){ this.statusCode = code; return this; };
    res.json = function(data){
      if(!this.headersSent){
        this.writeHead(this.statusCode || 200, {"Content-Type":"application/json"});
      }
      this.end(JSON.stringify(data));
    };
    await handler(req, res);
  });
});

server.listen(PORT, () => console.log(`[Ekamatho] Server berjalan di http://localhost:${PORT}`));
