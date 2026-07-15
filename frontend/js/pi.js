/**
 * frontend/js/pi.js (v2)
 * Pi SDK init & auth. fetchAppBalance sekarang ambil piBalance + idrBalance.
 */

function initPiSdk() {
  try { Pi.init({ version:'2.0', sandbox: CONFIG.PI_SANDBOX }); }
  catch(e) { console.warn('Pi SDK belum siap', e); }
}

const PiAuth = (() => {
  function setStatus(msg, cls='') {
    const el=document.getElementById('lstat');
    if(el){ el.textContent=msg; el.className='login-status '+cls; }
  }
  function setBtn(html, dis) {
    const btn=document.getElementById('loginBtn');
    if(btn){ btn.innerHTML=html; btn.disabled=dis; }
  }

  function onSuccess(user, accessToken) {
    S.user={ ...user, accessToken };
    document.getElementById('uav').textContent=(user.username||'P').charAt(0).toUpperCase();
    document.getElementById('uname').textContent='@'+user.username;
    document.getElementById('envTag').textContent=CONFIG.PI_SANDBOX?'Testnet · Sandbox':'Mainnet · Production';
    sessionStorage.setItem('pi_user', JSON.stringify({ ...user, isDemo:false }));
    sessionStorage.setItem('pi_access_token', accessToken);
    const sk=sessionStorage.getItem('kyc_data');
    if(sk){ try{ Object.assign(S.kycData, JSON.parse(sk)); }catch(_){} }
    toast('Selamat datang, @'+user.username);
    go('home');
  }

  async function fetchAppBalance(uid) {
    const r = await fetch('/api/wallet?action=balance&uid='+uid);
    const d = await r.json();
    S.piSaldo  = parseFloat(d.piBalance  || 0);
    S.idrSaldo = parseFloat(d.idrBalance || 0);
    if(d.kycStatus?.verifiedForIdr) {
      S.kycVerified = true;
      // Isi kycData dari kycStatus jika belum ada di session
      if(!S.kycData.accNum && d.kycStatus.accountNumber) {
        Object.assign(S.kycData, {
          accNum:  d.kycStatus.accountNumber,
          accName: d.kycStatus.accountHolderName,
          bankName:d.kycStatus.bankName,
          piName:  d.kycStatus.piName || '',
        });
      }
    }
    refresh();
    return d;
  }

  async function signIn() {
    setBtn('<div class="btn-pi-mark">π</div> Menghubungkan…', true);
    setStatus('Memeriksa Pi Browser…');
    if(typeof Pi==='undefined'){
      setStatus('Pi SDK tidak tersedia. Buka di Pi Browser atau gunakan Mode Demo.','err');
      setBtn('<div class="btn-pi-mark">π</div> Login dengan Pi Network', false);
      return;
    }
    try {
      setStatus('Menginisialisasi Pi SDK…');
      await Pi.init({ version:'2.0', sandbox: CONFIG.PI_SANDBOX });
      await new Promise(r=>setTimeout(r,200));
      setStatus('Menunggu persetujuan di Pi Browser…');
      setBtn('<div class="btn-pi-mark">π</div> Menunggu…', true);
      sessionStorage.clear();
      const auth = await Pi.authenticate(['username','payments'], async (inc) => {
        console.warn('[Auth] Incomplete payment:', inc.identifier);
        try {
          await fetch('/api/pi?action=complete', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ action:'complete', paymentId:inc.identifier, txid:inc.transaction?.txid||'', uid:auth?.user?.uid||'' })
          });
        } catch(e){ console.warn('[Auth] complete incomplete:', e); }
      });
      if(!auth?.accessToken) throw new Error('Tidak ada access token');
      setStatus('Login ke Ekamatho…');
      const login=await fetch('/api/auth',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ accessToken: auth.accessToken }) });
      const app=await login.json();
      const appUser=app.user;
      await fetchAppBalance(appUser.uid);
      setStatus('Login berhasil','ok');
      onSuccess(appUser, auth.accessToken);
    } catch(err){
      console.error('[Auth]', err);
      setStatus('Gagal: '+(err.message||'Unknown error'),'err');
      setBtn('<div class="btn-pi-mark">π</div> Login dengan Pi Network', false);
    }
  }

  function demo() {
    setStatus('Masuk mode demo…');
    setTimeout(()=>{
      S.piSaldo=125.50; S.idrSaldo=0; S.isDemo=true;
      const user={ username:'demo_pioneer', uid:'demo-uid-000', email:'demo@pi.network', isDemo:true };
      S.user=user;
      document.getElementById('uav').textContent='D';
      document.getElementById('uname').textContent='@demo';
      document.getElementById('envTag').textContent='Mode Demo';
      sessionStorage.setItem('pi_user', JSON.stringify(user));
      setStatus('Mode demo aktif','ok');
      go('home');
    },500);
  }

  async function refreshBalance() {
    if(!S.user?.uid) return;
    await fetchAppBalance(S.user.uid);
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    initPiSdk();
    const c=sessionStorage.getItem('pi_user');
    if(c){
      try{
        const u=JSON.parse(c); S.user=u;
        if(u.isDemo){ S.piSaldo=125.50; S.idrSaldo=0; S.isDemo=true; }
        document.getElementById('uav').textContent=(u.username||'P').charAt(0).toUpperCase();
        document.getElementById('uname').textContent='@'+u.username;
        const sk=sessionStorage.getItem('kyc_data');
        if(sk){ try{ Object.assign(S.kycData, JSON.parse(sk)); }catch(_){} }
        if(!u.isDemo && u.uid) fetchAppBalance(u.uid);
        go('home'); return;
      }catch(_){ sessionStorage.removeItem('pi_user'); }
    }
  });

  return { signIn, demo, refreshBalance };
})();
