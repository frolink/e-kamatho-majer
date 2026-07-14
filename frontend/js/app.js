/**
 * frontend/js/app.js
 * State global, navigasi, UI helpers, dan inisialisasi utama.
 */

// ── CONFIG & STATE ────────────────────────────────────────────────────────────
const CFG = { SANDBOX: true, RATE: 14000, FEE: 0.02, PI_VER: '2.0' };

const S = {
  piSaldo: 0, idrSaldo: 0, merchant: 'Indomaret', isDemo: false,
  user: { username: '', uid: '', email: '' },
  kyc: { name:'', accName:'', accNum:'', bankCode:'', bankName:'', payoutType:'bank', verified:false },
};

// ── UTILS ─────────────────────────────────────────────────────────────────────
const fmt  = n => Math.floor(parseFloat(n)||0).toLocaleString('id-ID');
const ts   = () => { const n=new Date(); return n.toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})+', '+n.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}); };
const wait = ms => new Promise(r => setTimeout(r, ms));

let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

// ── REFRESH UI ────────────────────────────────────────────────────────────────
function refresh() {
  const pi = S.piSaldo, idr = S.idrSaldo;
  const set = (id, v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  set('hPi',    pi.toFixed(2));
  set('hPiIdr', '≈ Rp '+fmt(pi*CFG.RATE)+' · Rp 14.000/π');
  set('hIdr',   'Rp '+fmt(idr));
  set('tuNow',   pi.toFixed(2));
  set('tuNowIdr','≈ Rp '+fmt(pi*CFG.RATE));
  set('poIdr',   'Rp '+fmt(idr));
  set('poInfo',  'Saldo tersedia: Rp '+fmt(idr));
  set('wPi',     pi.toFixed(2)+' π');
  set('wIdr',    'Rp '+fmt(idr));
  set('cvPiInfo','Saldo Pi: '+pi.toFixed(2)+' π');
  set('byIdrInfo','Saldo Rupiah: Rp '+fmt(idr));
  set('piSrcLbl', CFG.SANDBOX ? 'Dompet Pi · Testnet' : 'Dompet Pi · Mainnet');
  set('kycStatusTag', S.kyc.verified ? '✓ KYC Terverifikasi' : 'KYC belum lengkap');

  if (S.kyc.verified) {
    const ok = document.getElementById('poKycOk'); if (ok) ok.style.display = 'block';
    const w  = document.getElementById('poKycWarn'); if (w) w.style.display = 'none';
    set('poKycName', S.kyc.name+' · '+S.kyc.bankName);
    set('poKycAcc',  S.kyc.accNum+' · '+S.kyc.accName);
  } else {
    const ok = document.getElementById('poKycOk'); if (ok) ok.style.display = 'none';
    const w  = document.getElementById('poKycWarn'); if (w) w.style.display = 'flex';
  }
  const kw = document.getElementById('kycWarnPay');
  if (kw) kw.style.display = S.kyc.verified ? 'none' : 'flex';
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────
const NO_NAV = ['login','processing','success'];
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById('bnav').style.display = NO_NAV.includes(id) ? 'none' : 'flex';
  if (!NO_NAV.includes(id)) {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('on'));
    const bn = document.getElementById('bn-'+id); if (bn) bn.classList.add('on');
  }
  refresh();
  window.scrollTo(0, 0);
}

// ── BACKEND HELPERS ───────────────────────────────────────────────────────────
async function callPi(body) {
  const action = body.action;
  const r = await fetch('/api/pi?action=' + action, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });

  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Backend error ' + r.status);
  return d;
}

// ── PROCESSING STEPS ──────────────────────────────────────────────────────────
function pStep(n, st, name, desc) {
  const ico = document.getElementById('pi'+n), pst = document.getElementById('pst'+n);
  if (!ico || !pst) return;
  ico.className = 'proc-ico' + (st==='act' ? ' active' : st==='done' ? ' done' : '');
  pst.textContent = st==='act' ? '⏳' : st==='done' ? '✅' : '—';
  if (name) document.getElementById('pn'+n).textContent = name;
  if (desc) document.getElementById('pd'+n).textContent = desc;
}

// ── SUCCESS ───────────────────────────────────────────────────────────────────
function showSuccess({ ttl, sub, type, dest, pi, idr, via, tx }) {
  const set = (id, v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  set('sucTtl', ttl); set('sucSub', sub);
  set('rcType', type); set('rcDest', dest);
  set('rcPi',   pi);   set('rcIdr',  idr);
  set('rcVia',  via);
  set('rcTx', String(tx).slice(0,28) + (String(tx).length>28?'…':''));
  set('rcTime', ts());
  go('success');
}

// ── MISC ──────────────────────────────────────────────────────────────────────
function pickM(name, el) {
  S.merchant = name;
  document.querySelectorAll('.merchant-chip').forEach(c => c.classList.remove('on'));
  el.classList.add('on');
}
function showProfile() { toast('@'+S.user.username+' · '+S.user.uid.slice(0,10)+'…'); }
function openNotif()  { document.getElementById('novlay').classList.add('open');  document.getElementById('npanel').classList.add('open'); }
function closeNotif() { document.getElementById('novlay').classList.remove('open'); document.getElementById('npanel').classList.remove('open'); }
