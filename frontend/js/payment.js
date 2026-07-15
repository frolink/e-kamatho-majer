/**
 * frontend/js/payment.js (v2)
 *
 * TopUp: Pi SDK → piSaldo bertambah (TIDAK ada konversi ke IDR)
 * Payment (Bayar Merchant): idrSaldo → TransFi Payout → Merchant
 *   (TIDAK membuka Pi Wallet)
 */

// ── TOP UP PI ─────────────────────────────────────────────────────────────────
const TopUp = (() => {
  async function exec() {
    const amt = parseFloat(document.getElementById('tuAmt').value) || 0;
    if (amt <= 0) { toast('Masukkan jumlah Pi'); return; }
    const btn = document.getElementById('tuBtn');
    btn.disabled=true; btn.textContent='Memproses…';
    document.getElementById('procTitle').textContent = 'Top Up Pi';
    go('processing'); [1,2,3,4].forEach(n => pStep(n,'idle','—','—'));

    if (S.isDemo || typeof Pi === 'undefined') {
      pStep(1,'act','Pi.createPayment()','Membuat payment di Pi Network'); await wait(900); pStep(1,'done');
      pStep(2,'act','Backend Approve','/api/pi → approve'); await wait(800); pStep(2,'done');
      pStep(3,'act','Backend Complete','/api/pi → complete'); await wait(800); pStep(3,'done');
      pStep(4,'act','Saldo Pi bertambah','piBalance +'+amt+' π'); await wait(600); pStep(4,'done');
      S.piSaldo = parseFloat((S.piSaldo + amt).toFixed(4));
      refresh(); resetTU(); btn.disabled=false; btn.textContent='➕ Top Up via Pi Network';
      showSuccess({ ttl:'Top Up Berhasil', sub:'+'+amt+' π masuk Dompet Pi', type:'Top Up Pi (Demo)', dest:'Dompet Pi', pi:'+'+amt.toFixed(4)+' π', idr:'—', via:'Pi Network · Demo', tx:'demo-'+Date.now() });
      return;
    }

    try {
      const payData = { amount:amt, memo:'Top Up Ekamatho ('+amt+' π)', metadata:{ type:'topup', pi_amount:amt, timestamp: new Date().toISOString() } };
      pStep(1,'act','Pi.createPayment()','Membuat payment di Pi Network');
      await new Promise((res,rej) => {
        Pi.createPayment(payData, {
          onReadyForServerApproval: async (paymentId) => {
            pStep(1,'done'); pStep(2,'act','Backend Approve','/api/pi');
            try { await callPi({ action:'approve', paymentId, uid:S.user.uid }); } catch(e){ console.warn(e); }
          },
          onReadyForServerCompletion: async (paymentId, txid) => {
            pStep(2,'done'); pStep(3,'act','Backend Complete','/api/pi');
            try {
              const r = await callPi({ action:'complete', paymentId, txid, uid:S.user.uid });
              pStep(3,'done'); pStep(4,'act','Saldo Pi diperbarui','piBalance bertambah');
              S.piSaldo = parseFloat((r.newPiBalance || S.piSaldo+amt).toFixed(4));
              await wait(500); pStep(4,'done'); refresh(); resetTU();
              res({ paymentId, txid });
            } catch(e){ rej(e); }
          },
          onCancel: () => rej(new Error('CANCELLED')),
          onError:  (e) => rej(e),
        });
      });
      btn.disabled=false; btn.textContent='➕ Top Up via Pi Network';
      showSuccess({ ttl:'Top Up Berhasil', sub:'+'+amt+' π masuk Dompet Pi', type:'Top Up Pi', dest:'Dompet Pi', pi:'+'+amt.toFixed(4)+' π', idr:'—', via:'Pi Network · /api/pi', tx:'Lihat Vercel Logs' });
    } catch(err) {
      btn.disabled=false; btn.textContent='➕ Top Up via Pi Network';
      if(err.message==='CANCELLED') toast('Top Up dibatalkan');
      else toast('Top Up gagal: '+(err.message||'Error'));
      go('topup');
    }
  }

  function resetTU() {
    document.getElementById('tuAmt').value='';
    document.getElementById('tuPrev').style.display='none';
    document.querySelectorAll('.pill').forEach(p=>p.classList.remove('on'));
  }
  return { exec };
})();

function setTU(amt) {
  document.getElementById('tuAmt').value=amt;
  document.querySelectorAll('.pill').forEach(p=>p.classList.toggle('on', parseFloat(p.textContent)===amt));
  prevTU(amt);
}
function prevTU(v) {
  const amt=parseFloat(v)||0;
  if(amt<=0){ document.getElementById('tuPrev').style.display='none'; return; }
  document.getElementById('tuPrev').style.display='block';
  document.getElementById('tupPi').textContent  = amt.toFixed(4)+' π';
  document.getElementById('tupAft').textContent = (S.piSaldo+amt).toFixed(4)+' π';
  document.getElementById('tupIdr').textContent = 'Rp '+fmt(amt*CFG.RATE);
}

// ── BAYAR MERCHANT (pakai idrSaldo — TIDAK pakai Pi SDK) ─────────────────────
const Payment = (() => {
  async function exec() {
    const idr = parseFloat(document.getElementById('payIdr').value) || 0;
    if (idr <= 0) { toast('Masukkan total belanja IDR'); return; }
    if (!S.kycVerified) { toast('Konversi Pi → Rupiah terlebih dahulu sebelum bayar merchant'); go('convert'); return; }
    if (idr > S.idrSaldo) { toast('Saldo Rupiah tidak cukup (Rp '+fmt(S.idrSaldo)+'). Konversi Pi dulu!'); return; }

    document.getElementById('procTitle').textContent = 'Bayar '+S.merchant;
    go('processing'); [1,2,3,4].forEach(n=>pStep(n,'idle','—','—'));

    if (S.isDemo) {
      pStep(1,'act','Cek Saldo Rupiah','idrBalance: Rp '+fmt(idr)); await wait(600); pStep(1,'done');
      pStep(2,'act','TransFi Payout','/api/merchant → payout'); await wait(900); pStep(2,'done');
      pStep(3,'act','Transfer ke Merchant','Bank/VA via TransFi'); await wait(900); pStep(3,'done');
      pStep(4,'act','Pembayaran sukses','Saldo Rupiah berkurang'); await wait(600); pStep(4,'done');
      S.idrSaldo -= idr; refresh();
      showSuccess({ ttl:'Pembayaran Berhasil', sub:'Rp '+fmt(idr)+' → '+S.merchant, type:'Bayar Merchant (Demo)', dest:S.merchant, pi:'—', idr:'Rp '+fmt(idr), via:'TransFi Payout (Demo)', tx:'demo-pay-'+Date.now() });
      return;
    }

    try {
      pStep(1,'act','Cek Saldo Rupiah','idrBalance: Rp '+fmt(S.idrSaldo));
      await wait(300); pStep(1,'done');
      pStep(2,'act','TransFi Payout','/api/merchant');
      // Cari merchantId dari S.merchant (nama) — untuk demo pakai global_indomaret, dll
      const merchantMap = { 'Indomaret':'global_indomaret', 'Alfamart':'global_alfamart', 'PLN':'global_pln' };
      const merchantId  = merchantMap[S.merchant] || 'global_indomaret';
      const r = await callMerchant('payout', { uid:S.user.uid, merchantId, amountIdr: idr });
      pStep(2,'done'); pStep(3,'act','Transfer ke Merchant','Bank/VA via TransFi'); await wait(700);
      pStep(3,'done'); pStep(4,'act','Pembayaran sukses',''); await wait(400); pStep(4,'done');
      S.idrSaldo = r.newIdrBalance !== undefined ? r.newIdrBalance : S.idrSaldo - idr;
      refresh();
      showSuccess({ ttl:'Pembayaran Berhasil', sub:'Rp '+fmt(idr)+' → '+S.merchant, type:'Bayar Merchant', dest:S.merchant, pi:'—', idr:'Rp '+fmt(idr), via:'TransFi Payout · /api/merchant', tx: r.payoutId || 'Lihat Vercel Logs' });
    } catch(err) {
      toast('Pembayaran gagal: '+(err.message||'Error'));
      go('payment');
    }
  }
  return { exec };
})();

function calcPay(v) {
  const idr=parseFloat(v)||0;
  if(idr<=0){ document.getElementById('payPrev').style.display='none'; return; }
  document.getElementById('payPrev').style.display='block';
  document.getElementById('pfIDR').textContent  = 'Rp '+fmt(idr);
  document.getElementById('pfAft').textContent  = 'Rp '+fmt(S.idrSaldo-idr);
  document.getElementById('pfBal').textContent  = 'Rp '+fmt(S.idrSaldo);
}
function selMP(el, name) {
  S.merchant=name;
  document.querySelectorAll('.merch-opt').forEach(m=>m.classList.remove('on'));
  el.classList.add('on');
}
