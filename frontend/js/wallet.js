/**
 * frontend/js/wallet.js
 * KYC, Payout IDR via TransFi, Konversi Pi⇄IDR.
 */

// ── KYC ───────────────────────────────────────────────────────────────────────
let kycPayoutType = 'bank';

function selPayout(el, type) {
  document.querySelectorAll('.pt-opt').forEach(e => {
    e.classList.remove('on');
    e.querySelector('.pt-check').textContent = '○';
  });
  el.classList.add('on');
  el.querySelector('.pt-check').textContent = '✓';
  kycPayoutType = type;
  const bf = document.getElementById('bankSelectField');
  if (bf) bf.style.display = type === 'bank' ? 'block' : 'none';
  const lbl = document.getElementById('accNumLabel');
  if (lbl) lbl.textContent = type === 'bank' ? 'Nomor rekening' : type === 'qris' ? 'Nomor HP QRIS' : 'Nomor Virtual Account';
}

const KYC = (() => {
  function save() {
    const name     = document.getElementById('kycName')?.value.trim();
    const accName  = document.getElementById('kycAccName')?.value.trim();
    const accNum   = document.getElementById('kycAccNum')?.value.trim();
    const bankCode = document.getElementById('kycBank')?.value || '';
    const sel      = document.getElementById('kycBank');
    const bankName = sel?.options[sel.selectedIndex]?.text || '';
    if (!name)    { toast('Masukkan nama lengkap sesuai Pi KYC'); return; }
    if (!accName) { toast('Masukkan nama pemilik rekening'); return; }
    if (!accNum)  { toast('Masukkan nomor rekening / QRIS / VA'); return; }
    if (kycPayoutType === 'bank' && !bankCode) { toast('Pilih nama bank'); return; }
    if (name.toLowerCase() !== accName.toLowerCase()) { toast('Nama rekening harus sama persis dengan nama Pi KYC'); return; }
    Object.assign(S.kyc, { name, accName, accNum, bankCode, bankName, payoutType: kycPayoutType, verified: true });
    sessionStorage.setItem('kyc_data', JSON.stringify(S.kyc));
    toast('KYC berhasil disimpan');
    refresh(); go('home');
  }
  return { save };
})();

// ── PAYOUT IDR ────────────────────────────────────────────────────────────────
async function callTF(body) {
  const r = await fetch('/api/transfi', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error || 'TransFi error ' + r.status); return d;
}

const Payout = (() => {
  async function exec() {
    const amt = parseFloat(document.getElementById('poAmt').value) || 0;
    if (amt <= 0)  { toast('Masukkan jumlah payout'); return; }
    if (amt > S.idrSaldo) { toast('Saldo tidak cukup'); return; }
    if (!S.kyc.verified)  { toast('Lengkapi KYC terlebih dahulu'); go('kyc'); return; }
    if (S.kyc.name.toLowerCase() !== S.kyc.accName.toLowerCase()) { toast('Nama rekening ≠ nama Pi KYC. Perbarui KYC.'); go('kyc'); return; }
    document.getElementById('procTitle').textContent = 'Payout IDR via TransFi';
    go('processing'); [1,2,3,4].forEach(n => pStep(n,'idle','—','—'));
    pStep(1,'act','Verifikasi KYC','Nama rekening = nama Pi KYC');
    await wait(700); pStep(1,'done');
    pStep(2,'act','TransFi Payout Request','/api/transfi → offramp');

    if (S.isDemo) {
      await wait(900); pStep(2,'done');
      pStep(3,'act','TransFi Processing','Mengirim ke '+S.kyc.bankName); await wait(900);
      pStep(3,'done'); pStep(4,'act','Payout sukses','IDR masuk rekening'); await wait(600);
      pStep(4,'done'); S.idrSaldo -= amt; refresh();
      showSuccess({ ttl:'Payout Berhasil', sub:'IDR dikirim ke '+S.kyc.bankName, type:'TransFi Payout (Demo)', dest:S.kyc.bankName+' · '+S.kyc.accNum, pi:'—', idr:'Rp '+fmt(amt), via:'TransFi · Demo', tx:'demo-payout-'+Date.now() });
      return;
    }
    try {
      const r = await callTF({ action:'offramp', piAmount:0, idrAmount:amt, user:{ uid:S.user.uid, username:S.user.username, email:S.user.email, piKycName:S.kyc.name }, bankAccount:{ type:S.kyc.payoutType, accountNumber:S.kyc.accNum, accountName:S.kyc.accName, bankCode:S.kyc.bankCode, bankName:S.kyc.bankName } });
      pStep(2,'done'); pStep(3,'act','TransFi Processing','Mengirim ke rekening…'); await wait(700);
      pStep(3,'done'); pStep(4,'act','Payout sukses','IDR dikirim'); await wait(500); pStep(4,'done');
      S.idrSaldo -= amt; refresh();
      showSuccess({ ttl:'Payout Berhasil', sub:'IDR dikirim ke '+S.kyc.bankName, type:'TransFi Payout', dest:S.kyc.bankName+' · '+S.kyc.accNum, pi:'—', idr:'Rp '+fmt(amt), via:'TransFi · /api/transfi', tx: r.orderId || 'Lihat Vercel Logs' });
    } catch (err) { toast('Payout gagal: ' + (err.message || 'Error')); go('payout'); }
  }
  return { exec };
})();

function chkPO(v) {
  const amt = parseFloat(v) || 0;
  const info = document.getElementById('poInfo'); if (!info) return;
  if (amt > S.idrSaldo) { info.textContent = 'Melebihi saldo tersedia'; info.style.color = 'var(--rose)'; }
  else { info.textContent = 'Saldo tersedia: Rp ' + fmt(S.idrSaldo); info.style.color = 'var(--muted)'; }
}

// ── KONVERSI TABS ─────────────────────────────────────────────────────────────
function switchTab(t) {
  document.getElementById('t1').classList.toggle('on', t === 'p2i');
  document.getElementById('t2').classList.toggle('on', t === 'i2p');
  document.getElementById('panP2I').style.display = t === 'p2i' ? 'flex' : 'none';
  document.getElementById('panI2P').style.display = t === 'i2p' ? 'flex' : 'none';
}
function calcCV(v) { const pi = parseFloat(v)||0; document.getElementById('cvIdr').value = pi>0 ? fmt(Math.floor(pi*CFG.RATE*(1-CFG.FEE))) : ''; }
function calcBuy(v) { const idr = parseFloat(v)||0; document.getElementById('byPi').value = idr>0 ? ((idr*(1-CFG.FEE))/CFG.RATE).toFixed(4) : ''; }
function selP(el) { document.querySelectorAll('.partner-pill').forEach(p=>p.classList.remove('on')); el.classList.add('on'); }
