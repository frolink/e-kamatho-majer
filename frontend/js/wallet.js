/**
 * frontend/js/wallet.js (v2)
 *
 * KYC:       Simpan data rekening user untuk AML
 * Konversi:  piSaldo → /api/convert → idrSaldo (setelah webhook)
 * Tarik:     idrSaldo → /api/withdraw → rekening bank user
 */

// ── KYC ───────────────────────────────────────────────────────────────────────
let kycPayoutType = 'bank';

function selPayout(el, type) {
  document.querySelectorAll('.pt-opt').forEach(e => {
    e.classList.remove('on');
    e.querySelector('.pt-check').textContent='○';
  });
  el.classList.add('on'); el.querySelector('.pt-check').textContent='✓';
  kycPayoutType=type;
  const bf=document.getElementById('bankSelectField');
  if(bf) bf.style.display=type==='bank'?'block':'none';
  const lbl=document.getElementById('accNumLabel');
  if(lbl) lbl.textContent=type==='bank'?'Nomor rekening':type==='qris'?'Nomor HP QRIS':'Nomor Virtual Account';
}

const KYC = (() => {
  function save() {
    const piName  = document.getElementById('kycName')?.value.trim();
    const accName = document.getElementById('kycAccName')?.value.trim();
    const accNum  = document.getElementById('kycAccNum')?.value.trim();
    const sel     = document.getElementById('kycBank');
    const bankCode= sel?.value || '';
    const bankName= sel?.options[sel.selectedIndex]?.text || '';
    if(!piName)   { toast('Masukkan nama lengkap sesuai Pi KYC'); return; }
    if(!accName)  { toast('Masukkan nama pemilik rekening'); return; }
    if(!accNum)   { toast('Masukkan nomor rekening'); return; }
    if(kycPayoutType==='bank' && !bankCode) { toast('Pilih nama bank'); return; }
    // Cek kesamaan nama (frontend saja — backend cek ulang saat konversi)
    const nm = (a,b) => a.toLowerCase().trim()===b.toLowerCase().trim();
    if(!nm(piName,accName)) { toast('Nama rekening harus sama dengan nama Pi KYC (akan diverifikasi saat konversi)'); }
    Object.assign(S.kycData, { piName, accName, accNum, bankCode, bankName, payoutType: kycPayoutType });
    sessionStorage.setItem('kyc_data', JSON.stringify(S.kycData));
    toast('Data KYC disimpan. Lakukan Konversi Pi → Rupiah untuk verifikasi AML.');
    refresh(); go('home');
  }
  return { save };
})();

// ── KONVERSI Pi → IDR ──────────────────────────────────────────────────────────
const Convert = (() => {
  async function exec() {
    const amtPi = parseFloat(document.getElementById('cvPi').value) || 0;
    if(amtPi<=0) { toast('Masukkan jumlah Pi yang akan dikonversi'); return; }
    if(amtPi > S.piSaldo) { toast('Saldo Pi tidak cukup ('+S.piSaldo.toFixed(2)+' π)'); return; }
    if(!S.kycData.piName) { toast('Lengkapi data KYC terlebih dahulu'); go('kyc'); return; }

    document.getElementById('procTitle').textContent='Konversi Pi → Rupiah';
    go('processing'); [1,2,3,4].forEach(n=>pStep(n,'idle','—','—'));

    if(S.isDemo) {
      pStep(1,'act','Verifikasi KYC & AML','Cocokkan nama Pi dengan rekening'); await wait(800); pStep(1,'done');
      pStep(2,'act','Debit Saldo Pi','piBalance -'+amtPi+' π'); await wait(600); pStep(2,'done');
      pStep(3,'act','TransFi Offramp','Pi → IDR sedang diproses'); await wait(1000); pStep(3,'done');
      pStep(4,'act','Menunggu Settlement','IDR masuk setelah TransFi konfirmasi'); await wait(700); pStep(4,'done');
      const idrEst = Math.floor(amtPi * CFG.RATE * (1-CFG.FEE));
      S.piSaldo  = parseFloat((S.piSaldo-amtPi).toFixed(4));
      S.idrSaldo += idrEst;
      S.kycVerified = true;
      refresh();
      showSuccess({ ttl:'Konversi Dimulai', sub:'Saldo Rupiah +Rp '+fmt(idrEst)+' (estimasi)', type:'Konversi Pi→IDR (Demo)', dest:'Dompet Rupiah', pi:'-'+amtPi.toFixed(4)+' π', idr:'≈ Rp '+fmt(idrEst), via:'TransFi Offramp (Demo)', tx:'demo-cv-'+Date.now() });
      return;
    }

    try {
      pStep(1,'act','Verifikasi KYC & AML','Cocokkan nama Pi dengan rekening');
      const r = await callConvert({
        uid: S.user.uid,
        amountPi: amtPi,
        piKycName:        S.kycData.piName,
        bankName:         S.kycData.bankName,
        accountNumber:    S.kycData.accNum,
        accountHolderName:S.kycData.accName,
      });
      pStep(1,'done'); pStep(2,'act','Saldo Pi dikurangi','piBalance -'+amtPi+' π'); await wait(500);
      pStep(2,'done'); pStep(3,'act','TransFi Offramp','Pi → IDR sedang diproses'); await wait(600);
      pStep(3,'done'); pStep(4,'act','Menunggu Settlement','IDR masuk setelah webhook'); await wait(500); pStep(4,'done');
      S.piSaldo  = parseFloat((S.piSaldo-amtPi).toFixed(4));
      S.kycVerified = true;
      refresh();
      showSuccess({ ttl:'Konversi Dimulai', sub:'IDR akan masuk setelah TransFi settle', type:'Konversi Pi→IDR', dest:'Dompet Rupiah', pi:'-'+amtPi.toFixed(4)+' π', idr:'Menunggu TransFi', via:'TransFi Offramp · /api/convert', tx: r.transfiOrderId || r.convertId || 'Lihat Vercel Logs' });
    } catch(err) {
      toast('Konversi gagal: '+(err.message||'Error'));
      go('convert');
    }
  }
  return { exec };
})();

function calcCV(v) {
  const pi=parseFloat(v)||0;
  document.getElementById('cvIdr').value=pi>0?fmt(Math.floor(pi*CFG.RATE*(1-CFG.FEE))):'';
}

// ── TARIK REKENING ────────────────────────────────────────────────────────────
const Withdraw = (() => {
  async function exec() {
    const idr = parseFloat(document.getElementById('wdAmt').value) || 0;
    if(idr<=0)        { toast('Masukkan jumlah penarikan'); return; }
    if(idr<10000)     { toast('Minimal penarikan Rp10.000'); return; }
    if(idr>S.idrSaldo){ toast('Saldo Rupiah tidak cukup'); return; }
    if(!S.kycData.piName) { toast('Lengkapi KYC terlebih dahulu'); go('kyc'); return; }

    document.getElementById('procTitle').textContent='Tarik Rekening';
    go('processing'); [1,2,3,4].forEach(n=>pStep(n,'idle','—','—'));

    if(S.isDemo) {
      pStep(1,'act','Cek KYC & Rekening','Verifikasi identitas'); await wait(700); pStep(1,'done');
      pStep(2,'act','Debit Saldo Rupiah','idrBalance -Rp '+fmt(idr)); await wait(600); pStep(2,'done');
      pStep(3,'act','TransFi Withdrawal','Transfer ke rekening'); await wait(1000); pStep(3,'done');
      pStep(4,'act','Transfer berhasil','IDR dikirim ke '+S.kycData.bankName); await wait(600); pStep(4,'done');
      S.idrSaldo-=idr; refresh();
      showSuccess({ ttl:'Penarikan Berhasil', sub:'Rp '+fmt(idr)+' → '+S.kycData.bankName, type:'Tarik Rekening (Demo)', dest:S.kycData.bankName+' · '+S.kycData.accNum, pi:'—', idr:'Rp '+fmt(idr), via:'TransFi Withdrawal (Demo)', tx:'demo-wd-'+Date.now() });
      return;
    }

    try {
      pStep(1,'act','Cek KYC & Rekening','Verifikasi identitas'); await wait(300); pStep(1,'done');
      pStep(2,'act','TransFi Withdrawal','/api/withdraw');
      const r = await callWithdraw({
        uid: S.user.uid,
        bankName:         S.kycData.bankName,
        accountNumber:    S.kycData.accNum,
        accountHolderName:S.kycData.accName,
        amountIdr: idr,
        piAccountName: S.kycData.piName,
      });
      pStep(2,'done'); pStep(3,'act','Transfer dikirim','Menunggu bank'); await wait(700);
      pStep(3,'done'); pStep(4,'act','Penarikan sukses',''); await wait(400); pStep(4,'done');
      S.idrSaldo = r.newIdrBalance !== undefined ? r.newIdrBalance : S.idrSaldo-idr;
      refresh();
      showSuccess({ ttl:'Penarikan Berhasil', sub:'Rp '+fmt(idr)+' → '+S.kycData.bankName, type:'Tarik Rekening', dest:S.kycData.bankName+' · '+S.kycData.accNum, pi:'—', idr:'Rp '+fmt(idr), via:'TransFi Withdrawal · /api/withdraw', tx: r.withdrawalId || 'Lihat Vercel Logs' });
    } catch(err) {
      toast('Penarikan gagal: '+(err.message||'Error'));
      go('withdraw');
    }
  }
  return { exec };
})();

function chkWD(v) {
  const idr=parseFloat(v)||0;
  const info=document.getElementById('wdInfo'); if(!info) return;
  if(idr>S.idrSaldo) { info.textContent='Melebihi saldo tersedia'; info.style.color='var(--rose)'; }
  else { info.textContent='Saldo tersedia: Rp '+fmt(S.idrSaldo); info.style.color='var(--muted)'; }
}
