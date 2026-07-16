/**
 * frontend/js/app.js (v2)
 * State global, navigasi, UI helpers.
 *
 * Perubahan:
 *   - S.piSaldo  = saldo Pi di app (top up → bertambah, konversi → berkurang)
 *   - S.idrSaldo = saldo Rupiah (konversi → bertambah, bayar/tarik → berkurang)
 *   - KYC state disederhanakan (kycVerified, kycData)
 */

const CFG = { SANDBOX: true, RATE: 5000000, FEE: 0.02, PI_VER: '2.0' };

const S = {
  piSaldo: 0,
  idrSaldo: 0,
  kycVerified: false,
  kycData: { piName:'', bankName:'', bankCode:'', accNum:'', accName:'', payoutType:'bank' },
  user: { username:'', uid:'', email:'' },
  isDemo: false,
  merchant: 'Indomaret',
};

// ── Utils ─────────────────────────────────────────────────────────────────────
const fmt  = n => Math.floor(parseFloat(n)||0).toLocaleString('id-ID');
const ts   = () => { const n=new Date(); return n.toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})+', '+n.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}); };
const wait = ms => new Promise(r => setTimeout(r, ms));

let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

// ── Refresh UI ─────────────────────────────────────────────────────────────────
function refresh() {
  const pi = S.piSaldo, idr = S.idrSaldo;
  const set = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };

  // Home — dua kartu saldo
  set('hPi',     pi.toFixed(2) + ' π');
  set('hPiIdr',  '≈ Rp ' + fmt(pi*CFG.RATE) + ' · Rp 5.000.000/π');
  set('hIdr',    'Rp ' + fmt(idr));

  // Top Up info
  set('tuNow',    pi.toFixed(2));
  set('tuNowIdr', '≈ Rp ' + fmt(pi*CFG.RATE));

  // Konversi
  set('cvPiInfo',  'Saldo Pi: ' + pi.toFixed(2) + ' π');
  set('wPi',       pi.toFixed(2) + ' π');
  set('wIdr',      'Rp ' + fmt(idr));

  // Bayar Merchant — tampilkan idrSaldo
  set('byIdrInfo', 'Saldo Rupiah: Rp ' + fmt(idr));
  set('payIdrBal', 'Rp ' + fmt(idr));

  // Tarik Rekening
  set('wdIdrBal',  'Rp ' + fmt(idr));
  set('wdInfo',    'Saldo tersedia: Rp ' + fmt(idr));

  // KYC status
  const tag = document.getElementById('kycStatusTag');
  if (tag) tag.textContent = S.kycVerified ? '✓ Verified for IDR Wallet' : 'KYC belum lengkap';

  // Payout info di Bayar Merchant
  const kycWarn = document.getElementById('kycWarnPay');
  if (kycWarn) kycWarn.style.display = S.kycVerified ? 'none' : 'flex';

  // Konversi — warna tombol kalau saldo 0
  const cvBtn = document.getElementById('cvBtn');
  if (cvBtn) cvBtn.disabled = (pi <= 0);
}

// ── Navigation ─────────────────────────────────────────────────────────────────
const NO_NAV = ['login','processing','success'];
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const sc = document.getElementById(id);
  if (sc) sc.classList.add('active');
  document.getElementById('bnav').style.display = NO_NAV.includes(id) ? 'none' : 'flex';
  if (!NO_NAV.includes(id)) {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('on'));
    const bn = document.getElementById('bn-'+id); if (bn) bn.classList.add('on');
  }
  refresh();
  window.scrollTo(0, 0);
}

// ── Backend Helpers ──────────────────────────────────────────────────────────
async function callPi(body) {
  const r = await fetch('/api/pi?action='+body.action, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Backend error ' + r.status);
  return d;
}
async function callConvert(body) {
  const accessToken = sessionStorage.getItem('pi_access_token') || '';
  const r = await fetch('/api/convert?action=initiate', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-pi-access-token': accessToken},
    body:JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Konversi error ' + r.status);
  return d;
}
async function callMerchant(action, body) {
  const r = await fetch('/api/merchant?action='+action, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Merchant error ' + r.status);
  return d;
}
async function callWithdraw(body) {
  const r = await fetch('/api/withdraw?action=submit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Withdraw error ' + r.status);
  return d;
}

// ── Processing steps ──────────────────────────────────────────────────────────
function pStep(n, st, name, desc) {
  const ico=document.getElementById('pi'+n), pst=document.getElementById('pst'+n);
  if (!ico||!pst) return;
  ico.className='proc-ico'+(st==='act'?' active':st==='done'?' done':'');
  pst.textContent=st==='act'?'⏳':st==='done'?'✅':'—';
  if(name) document.getElementById('pn'+n).textContent=name;
  if(desc) document.getElementById('pd'+n).textContent=desc;
}

// ── Success ───────────────────────────────────────────────────────────────────
function showSuccess({ ttl, sub, type, dest, pi, idr, via, tx }) {
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  set('sucTtl',ttl);set('sucSub',sub);set('rcType',type);set('rcDest',dest);
  set('rcPi',pi);set('rcIdr',idr);set('rcVia',via);
  set('rcTx', String(tx).slice(0,28)+(String(tx).length>28?'…':''));
  set('rcTime',ts());
  go('success');
}

// ── Misc ──────────────────────────────────────────────────────────────────────
function pickM(name, el) {
  S.merchant=name;
  document.querySelectorAll('.merchant-chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');
}
function showProfile() { toast('@'+S.user.username+' · '+S.user.uid.slice(0,10)+'…'); }
function openNotif()  { document.getElementById('novlay').classList.add('open');  document.getElementById('npanel').classList.add('open'); }
function closeNotif() { document.getElementById('novlay').classList.remove('open'); document.getElementById('npanel').classList.remove('open'); }
