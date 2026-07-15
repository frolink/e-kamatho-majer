#!/usr/bin/env node
/**
 * patch-ekamatho.js
 * Jalankan dari ROOT folder project: node patch-ekamatho.js
 */

const fs   = require('fs');
const path = require('path');
const ROOT = process.cwd();

function backup(fp) {
  if (fs.existsSync(fp)) {
    fs.copyFileSync(fp, fp + '.bak');
    console.log('  ✔ Backup:', fp + '.bak');
  }
}
function write(rel, content) {
  const full = path.join(ROOT, rel);
  backup(full);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  console.log('  ✔ Ditulis:', rel);
}

// ══════════════════════════════════════════
// 1. store.js → Vercel KV
// ══════════════════════════════════════════
const STORE_KV = `
const { kv } = require('@vercel/kv');

function defaultMerchants() {
  return {
    global_indomaret: { merchantId:'global_indomaret', scope:'global', name:'Indomaret', category:'Retail', paymentCode:'virtual_account', bankName:'BRI', accountNumber:'777081234567890', accountHolderName:'PT Indomarco Prismatama' },
    global_alfamart:  { merchantId:'global_alfamart',  scope:'global', name:'Alfamart',  category:'Retail', paymentCode:'virtual_account', bankName:'Permata', accountNumber:'888091234567890', accountHolderName:'PT Sumber Alfaria Trijaya' },
    global_pln:       { merchantId:'global_pln', scope:'global', name:'PLN (Token Listrik)', category:'Utilitas', paymentCode:'virtual_account', bankName:'BNI', accountNumber:'888888012345678', accountHolderName:'PT PLN (Persero)' },
  };
}
async function ensureDefaultMerchants() {
  const ex = await kv.get('merchants:global');
  if (ex && ex.length > 0) return;
  const m = defaultMerchants(); const ids = [];
  await Promise.all(Object.values(m).map(async v => { await kv.set(\`merchant:\${v.merchantId}\`, v); ids.push(v.merchantId); }));
  await kv.set('merchants:global', ids);
}

async function upsertUser({ uid, username, piAddress }) {
  const ex = (await kv.get(\`user:\${uid}\`)) || { appBalance: 0 };
  const u = { ...ex, uid, username, piAddress: piAddress || ex.piAddress || null };
  await kv.set(\`user:\${uid}\`, u); return u;
}
async function getUser(uid) { return (await kv.get(\`user:\${uid}\`)) || null; }
async function getAppBalance(uid) { const u = await kv.get(\`user:\${uid}\`); return u ? Number(u.appBalance||0) : 0; }
async function creditAppBalance(uid, amount) {
  const u = (await kv.get(\`user:\${uid}\`)) || { uid, appBalance: 0 };
  u.appBalance = Number(u.appBalance||0) + Number(amount);
  await kv.set(\`user:\${uid}\`, u); return u.appBalance;
}
async function debitAppBalance(uid, amount) {
  const u = (await kv.get(\`user:\${uid}\`)) || { uid, appBalance: 0 };
  const cur = Number(u.appBalance||0);
  if (cur < Number(amount)) throw new Error('Saldo tidak cukup');
  u.appBalance = cur - Number(amount);
  await kv.set(\`user:\${uid}\`, u); return u.appBalance;
}

async function getPiPayment(id) { return (await kv.get(\`payment:\${id}\`)) || null; }
async function savePiPaymentApproved(id, data) {
  const u = { ...(await kv.get(\`payment:\${id}\`) || {}), ...data, status: 'approved' };
  await kv.set(\`payment:\${id}\`, u); return u;
}
async function savePiPaymentCompleted(id, data) {
  const u = { ...(await kv.get(\`payment:\${id}\`) || {}), ...data, status: 'completed' };
  await kv.set(\`payment:\${id}\`, u); return u;
}

async function createTransfiOrder(order) {
  const d = { ...order, status: order.status || 'initiated' };
  await kv.set(\`transfiOrder:\${order.orderId}\`, d);
  if (order.piPaymentId) await kv.set(\`transfiByPi:\${order.piPaymentId}\`, order.orderId);
  return d;
}
async function getTransfiOrder(id) { return (await kv.get(\`transfiOrder:\${id}\`)) || null; }
async function updateTransfiOrder(id, data) {
  const u = { ...(await kv.get(\`transfiOrder:\${id}\`) || {}), ...data };
  await kv.set(\`transfiOrder:\${id}\`, u); return u;
}
async function findTransfiOrderByPiPaymentId(pid) {
  const oid = await kv.get(\`transfiByPi:\${pid}\`);
  return oid ? getTransfiOrder(oid) : null;
}

async function createPayout(p) { const d={...p,status:p.status||'pending'}; await kv.set(\`payout:\${p.payoutId}\`,d); return d; }
async function getPayout(id) { return (await kv.get(\`payout:\${id}\`)) || null; }
async function updatePayout(id, data) { const u={...(await kv.get(\`payout:\${id}\`)||{}), ...data}; await kv.set(\`payout:\${id}\`,u); return u; }

async function createWithdrawal(w) { const d={...w,status:w.status||'pending'}; await kv.set(\`withdrawal:\${w.withdrawalId}\`,d); return d; }
async function getWithdrawal(id) { return (await kv.get(\`withdrawal:\${id}\`)) || null; }
async function updateWithdrawal(id, data) { const u={...(await kv.get(\`withdrawal:\${id}\`)||{}), ...data}; await kv.set(\`withdrawal:\${id}\`,u); return u; }

async function createMerchant(m) {
  await kv.set(\`merchant:\${m.merchantId}\`, m);
  if (m.scope === 'global') {
    const idx = (await kv.get('merchants:global')) || [];
    if (!idx.includes(m.merchantId)) { idx.push(m.merchantId); await kv.set('merchants:global', idx); }
  } else if (m.ownerUid) {
    const k = \`merchants:user:\${m.ownerUid}\`;
    const idx = (await kv.get(k)) || [];
    if (!idx.includes(m.merchantId)) { idx.push(m.merchantId); await kv.set(k, idx); }
  }
  return m;
}
async function getMerchant(id) { await ensureDefaultMerchants(); return (await kv.get(\`merchant:\${id}\`)) || null; }
async function listMerchants(uid) {
  await ensureDefaultMerchants();
  const gids = (await kv.get('merchants:global')) || [];
  const uids = uid ? (await kv.get(\`merchants:user:\${uid}\`)) || [] : [];
  const all  = [...new Set([...gids, ...uids])];
  return (await Promise.all(all.map(id => kv.get(\`merchant:\${id}\`)))).filter(Boolean);
}

async function addTransaction(tx) {
  const k = \`transactions:\${tx.uid}\`;
  const list = (await kv.get(k)) || [];
  list.unshift({ ...tx, createdAt: new Date().toISOString() });
  if (list.length > 500) list.splice(500);
  await kv.set(k, list);
}
async function listTransactions(uid) { return (await kv.get(\`transactions:\${uid}\`)) || []; }

module.exports = {
  upsertUser, getUser, getAppBalance, creditAppBalance, debitAppBalance,
  getPiPayment, savePiPaymentApproved, savePiPaymentCompleted,
  createTransfiOrder, getTransfiOrder, updateTransfiOrder, findTransfiOrderByPiPaymentId,
  createPayout, getPayout, updatePayout,
  createWithdrawal, getWithdrawal, updateWithdrawal,
  createMerchant, getMerchant, listMerchants,
  addTransaction, listTransactions,
};
`.trimStart();

// ══════════════════════════════════════════
// 2. Patch api/pi.js — hapus double-credit
// ══════════════════════════════════════════
function patchPiJs() {
  const fp = path.join(ROOT, 'api', 'pi.js');
  if (!fs.existsSync(fp)) { console.log('  ⚠ api/pi.js tidak ditemukan, skip.'); return; }
  backup(fp);
  let src = fs.readFileSync(fp, 'utf-8');

  src = src.replace(
    /\n?\s*await store\.creditAppBalance\(uid, payment\.amount\);/g,
    '\n  // [PATCH] creditAppBalance dihapus — saldo IDR hanya dari /api/webhook setelah TransFi settle.'
  );
  src = src.replace(/\n?\s*console\.log\(["']Balance after credit:["'][^)]*\);/g, '');
  src = src.replace(/\n?\s*console\.log\(["']Balance credited:["'][^)]*\);/g, '');
  src = src.replace(
    /return res\.json\(\{\s*amountPi: payment\.amount,\s*piTxId: txid,\s*transfiOrderId\s*\}\);/,
    'return res.json({ amountPi: payment.amount, piTxId: txid, transfiOrderId, pendingIdr: true });'
  );
  src = src.replace(
    /return res\.json\(\{\s*amountPi: existing\.amount,\s*piTxId: existing\.txid,\s*transfiOrderId: existingOrder \? existingOrder\.orderId : null\s*\}\);/,
    'return res.json({ amountPi: existing.amount, piTxId: existing.txid, transfiOrderId: existingOrder ? existingOrder.orderId : null, pendingIdr: true });'
  );

  fs.writeFileSync(fp, src, 'utf-8');
  console.log('  ✔ Ditulis: api/pi.js');
}

// ══════════════════════════════════════════
// 3. vercel.json
// ══════════════════════════════════════════
const VERCEL_JSON = JSON.stringify({
  version: 2,
  outputDirectory: 'frontend',
  functions: { 'api/*.js': { memory: 256, maxDuration: 30 } },
  routes: [
    { src: '/api/(.*)', dest: '/api/$1' },
    { src: '/(.*)',     dest: '/$1' },
  ],
}, null, 2) + '\n';

// ══════════════════════════════════════════
// 4. package.json — tambah @vercel/kv
// ══════════════════════════════════════════
function patchPackageJson() {
  const fp = path.join(ROOT, 'package.json');
  if (!fs.existsSync(fp)) { console.log('  ⚠ package.json tidak ditemukan, skip.'); return; }
  backup(fp);
  const pkg = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  pkg.dependencies = pkg.dependencies || {};
  if (!pkg.dependencies['@vercel/kv']) {
    pkg.dependencies['@vercel/kv'] = '^3.0.0';
    console.log('  ✔ @vercel/kv ditambahkan');
  } else {
    console.log('  ℹ @vercel/kv sudah ada');
  }
  fs.writeFileSync(fp, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log('  ✔ Ditulis: package.json');
}

// ══════════════════════════════════════════
// RUN
// ══════════════════════════════════════════
console.log('\n🔧 Ekamatho Patcher\n');

console.log('[1/4] store.js → Vercel KV...');
write('backend/services/store.js', STORE_KV);

console.log('\n[2/4] api/pi.js → hapus double-credit...');
patchPiJs();

console.log('\n[3/4] vercel.json → tambah routes...');
write('vercel.json', VERCEL_JSON);

console.log('\n[4/4] package.json → tambah @vercel/kv...');
patchPackageJson();

console.log(`
✅ Selesai! Langkah selanjutnya:

   1. Buka Vercel Dashboard → Storage → Create KV Database
      → Connect ke project ini (jika belum)

   2. npm install
   3. vercel env pull
   4. vercel deploy

📌 File lama disimpan sebagai .bak
`);
