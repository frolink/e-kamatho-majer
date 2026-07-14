/**
 * frontend/js/pi.js
 * Pi SDK initialization & authentication.
 */

function initPiSdk() {
  try { Pi.init({ version: '2.0', sandbox: CONFIG.PI_SANDBOX }); }
  catch (e) { console.warn('Pi SDK belum siap', e); }
}

const PiAuth = (() => {
  function setStatus(msg, cls = '') {
    const el = document.getElementById('lstat');
    if (el) { el.textContent = msg; el.className = 'login-status ' + cls; }
  }
  function setBtn(html, dis) {
    const btn = document.getElementById('loginBtn');
    if (btn) { btn.innerHTML = html; btn.disabled = dis; }
  }

  async function fetchPiBalance(accessToken) {
    try {
      const r = await fetch('https://api.minepi.com/v2/me', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      if (!r.ok) return null;
      const d = await r.json();
      const bal = d.balance ?? d.wallet?.balance ?? null;
      console.log('[PiAuth] Pi balance from /v2/me:', bal);
      return bal;
    } catch (e) {
      console.warn('[PiAuth] fetchPiBalance failed:', e);
      return null;
    }
  }

  function onSuccess(user, accessToken) {
    S.user = { ...user, accessToken };
    const ini = (user.username || 'P').charAt(0).toUpperCase();
    document.getElementById('uav').textContent = ini;
    document.getElementById('uname').textContent = '@' + user.username;
    document.getElementById('envTag').textContent = CONFIG.PI_SANDBOX ? 'Testnet · Sandbox' : 'Mainnet · Production';
    sessionStorage.setItem('pi_user', JSON.stringify({ ...user, isDemo: false }));
    sessionStorage.setItem('pi_access_token', accessToken);
    const sk = sessionStorage.getItem('kyc_data');
    if (sk) { try { Object.assign(S.kyc, JSON.parse(sk)); } catch (_) {} }
    toast('Selamat datang, @' + user.username);
    go('home');
  }

  async function signIn() {
    setBtn('<div class="btn-pi-mark">π</div> Menghubungkan…', true);
    setStatus('Memeriksa Pi Browser…');
    if (typeof Pi === 'undefined') {
      setStatus('Pi SDK tidak tersedia. Buka di Pi Browser atau gunakan Mode Demo.', 'err');
      setBtn('<div class="btn-pi-mark">π</div> Login dengan Pi Network', false);
      return;
    }
    try {
      setStatus('Menginisialisasi Pi SDK…');
      await Pi.init({ version: CONFIG.PI_SANDBOX ? '2.0' : '2.0', sandbox: CONFIG.PI_SANDBOX });
      await new Promise(r => setTimeout(r, 200));
      setStatus('Menunggu persetujuan di Pi Browser…');
      setBtn('<div class="btn-pi-mark">π</div> Menunggu…', true);
      const auth = await Pi.authenticate(
        ['username', 'payments'],
        async (inc) => {
          console.warn('[Auth] Incomplete payment:', inc.identifier);
          try {
            await fetch('/api/pi?action=complete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    action: 'complete',
    paymentId: inc.identifier,
    txid: inc.transaction?.txid || '',
    uid: auth.user.uid
  })
});
          } catch (e) { console.warn('[Auth] complete incomplete:', e); }
        }
      );
      if (!auth?.accessToken) throw new Error('Tidak ada access token');
      setStatus('Mengambil data wallet Pi Testnet…');
      const me = await fetch('https://api.minepi.com/v2/me', {
        headers: { Authorization: 'Bearer ' + auth.accessToken }
      });
      if (!me.ok) throw new Error('Validasi gagal: HTTP ' + me.status);
      const user = await me.json();
      const login = await fetch('/api/auth', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ accessToken: auth.accessToken })
      });
      const app = await login.json();
      const appUser = app.user;
      console.log("Login UID:", appUser.uid);
      const rawBal = user.balance ?? user.wallet_balance ?? user.wallet?.balance ?? null;
      S.piSaldo = await fetchAppBalance(appUser.uid);
      setStatus('Login berhasil', 'ok');
      onSuccess(appUser, auth.accessToken);
    } catch (err) {
      console.error('[Auth]', err);
      setStatus('Gagal: ' + (err.message || 'Unknown error'), 'err');
      setBtn('<div class="btn-pi-mark">π</div> Login dengan Pi Network', false);
    }
  }

  function demo() {
    setStatus('Masuk mode demo…');
    setTimeout(() => {
      S.piSaldo = 248.75; S.idrSaldo = 0; S.isDemo = true;
      const user = { username: 'demo_pioneer', uid: 'demo-uid-000', email: 'demo@pi.network', isDemo: true };
      S.user = user;
      document.getElementById('uav').textContent = 'D';
      document.getElementById('uname').textContent = '@demo';
      document.getElementById('envTag').textContent = 'Mode Demo';
      sessionStorage.setItem('pi_user', JSON.stringify(user));
      setStatus('Mode demo aktif', 'ok');
      go('home');
    }, 500);
  }

async function fetchAppBalance(uid) {  const r = await fetch('/api/wallet?action=balance&uid=' + uid);  const d = await r.json();  return d.appBalance || 0;}
  async function refreshPiBalance() {
    if (!S.user?.uid) return null;
    console.log("Refresh UID:", S.user.uid);
    const bal = await fetchAppBalance(S.user.uid);
    S.piSaldo = parseFloat(bal) || 0;
    refresh();
    console.log("[PiAuth] Saldo aplikasi diperbarui:", S.piSaldo);
    return bal;
  }

  window.addEventListener('DOMContentLoaded', () => {
    initPiSdk();
    const c = sessionStorage.getItem('pi_user');
    if (c) {
      try {
        const u = JSON.parse(c);
        S.user = u;
        if (u.isDemo) { S.piSaldo = 248.75; S.idrSaldo = 0; S.isDemo = true; }
        document.getElementById('uav').textContent = (u.username || 'P').charAt(0).toUpperCase();
        document.getElementById('uname').textContent = '@' + u.username;
        const sk = sessionStorage.getItem('kyc_data');
        if (sk) { try { Object.assign(S.kyc, JSON.parse(sk)); } catch (_) {} }
        if (!u.isDemo) {
          const token = sessionStorage.getItem('pi_access_token');
          if (u.uid) fetchAppBalance(u.uid).then(bal => { S.piSaldo = parseFloat(bal) || 0; refresh(); });
        }
        go('home'); return;
      } catch (_) { sessionStorage.removeItem('pi_user'); }
    }
    // Auto login disabled
  });

  return { signIn, demo, refreshPiBalance };
})();
