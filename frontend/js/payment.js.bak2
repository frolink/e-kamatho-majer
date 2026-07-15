/**
 * frontend/js/payment.js
 * Top Up Pi (Jalur 1) & Bayar Merchant (Jalur 2).
 */

// ── TOP UP PI ─────────────────────────────────────────────────────────────────
const TopUp = (() => {
  async function exec() {
    const amt = parseFloat(document.getElementById('tuAmt').value) || 0;
    if (amt <= 0) { toast('Masukkan jumlah Pi'); return; }
    const btn = document.getElementById('tuBtn');
    btn.disabled = true; btn.textContent = 'Memproses…';
    document.getElementById('procTitle').textContent = 'Top Up Pi';
    go('processing');
    [1,2,3,4].forEach(n => pStep(n, 'idle', '—', '—'));

    if (S.isDemo || typeof Pi === 'undefined') {
      pStep(1,'act','Pi.createPayment()','Membuat payment di Pi Network'); await wait(900); pStep(1,'done');
      pStep(2,'act','Backend Approve','/api/pi → approve'); await wait(800); pStep(2,'done');
      pStep(3,'act','Backend Complete','/api/pi → complete'); await wait(800); pStep(3,'done');
      pStep(4,'act','Saldo bertambah','Pi Platform konfirmasi'); await wait(600); pStep(4,'done');
      S.piSaldo = parseFloat((S.piSaldo + amt).toFixed(4));
      refresh(); resetTU();
      btn.disabled = false; btn.textContent = '➕ Top Up via Pi Network';
      showSuccess({ ttl:'Top Up Berhasil', sub:'+'+amt+' π masuk Dompet Ekamatho', type:'Top Up Pi (Demo)', dest:'Dompet Ekamatho', pi:'+'+amt.toFixed(4)+' π', idr:'Rp '+fmt(amt*CFG.RATE), via:'Pi Network · Demo', tx:'demo-'+Date.now() });
      return;
    }

    try {
      const payData = { amount: amt, memo: 'Top Up E-Kamatho Majer ('+amt+' π)', metadata: { type:'topup', pi_amount:amt, app:'e-kamatho-majer', timestamp: new Date().toISOString() } };
      pStep(1,'act','Pi.createPayment()','Membuat payment di Pi Network');
      await new Promise((res, rej) => {
        Pi.createPayment(payData, {
          onReadyForServerApproval: async (paymentId) => {
            pStep(1,'done'); pStep(2,'act','Backend Approve','/api/pi');
            try { await callPi({ action:'approve', paymentId, uid:S.user.uid }); } catch (e) { console.warn(e); }
          },
          onReadyForServerCompletion: async (paymentId, txid) => {
            pStep(2,'done'); pStep(3,'act','Backend Complete','/api/pi');
            try {
              await callPi({ action:'complete', paymentId, txid, uid:S.user.uid, meta:{ type:'topup', piAmount:amt } });
              pStep(3,'done'); pStep(4,'act','Saldo diperbarui','Mengambil saldo terbaru dari Dompet Ekamatho');
              const token = sessionStorage.getItem('pi_access_token');
              if (token) { await PiAuth.refreshPiBalance(); } else { S.piSaldo = parseFloat((S.piSaldo+amt).toFixed(4)); }
              await wait(500); pStep(4,'done');
              refresh(); resetTU(); res({ paymentId, txid });
            } catch (e) { rej(e); }
          },
          onCancel: () => rej(new Error('CANCELLED')),
          onError:  (e) => rej(e),
        });
      });
      btn.disabled = false; btn.textContent = '➕ Top Up via Pi Network';
      showSuccess({ ttl:'Top Up Berhasil', sub:'+'+amt+' π masuk Dompet Ekamatho', type:'Top Up Pi', dest:'Dompet Ekamatho', pi:'+'+amt.toFixed(4)+' π', idr:'Rp '+fmt(amt*CFG.RATE), via:'Pi Network · /api/pi', tx:'Lihat Vercel Logs' });
    } catch (err) {
      btn.disabled = false; btn.textContent = '➕ Top Up via Pi Network';
      if (err.message === 'CANCELLED') toast('Top Up dibatalkan');
      else toast('Top Up gagal: ' + (err.message || 'Error'));
      go('topup');
    }
  }

  function resetTU() {
    document.getElementById('tuAmt').value = '';
    document.getElementById('tuPrev').style.display = 'none';
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('on'));
  }
  return { exec };
})();

function setTU(amt) {
  document.getElementById('tuAmt').value = amt;
  document.querySelectorAll('.pill').forEach(p => p.classList.toggle('on', parseFloat(p.textContent) === amt));
  prevTU(amt);
}
function prevTU(v) {
  const amt = parseFloat(v) || 0;
  if (amt <= 0) { document.getElementById('tuPrev').style.display = 'none'; return; }
  document.getElementById('tuPrev').style.display = 'block';
  document.getElementById('tupPi').textContent  = amt.toFixed(4) + ' π';
  document.getElementById('tupAft').textContent = (S.piSaldo + amt).toFixed(4) + ' π';
  document.getElementById('tupIdr').textContent = 'Rp ' + fmt(amt * CFG.RATE);
}

// ── BAYAR MERCHANT ────────────────────────────────────────────────────────────
const Payment = (() => {
  async function exec() {
    const idr = parseFloat(document.getElementById('payIdr').value) || 0;
    if (idr <= 0) { toast('Masukkan total belanja IDR'); return; }
    if (!S.kyc.verified) { toast('Lengkapi KYC & rekening terlebih dahulu'); go('kyc'); return; }
    const piB = idr / CFG.RATE, piT = parseFloat((piB / (1-CFG.FEE)).toFixed(4)), piF = parseFloat((piT-piB).toFixed(4));
    if (piT > S.piSaldo) { toast('Saldo Pi tidak cukup ('+S.piSaldo.toFixed(2)+' π). Top Up dulu!'); return; }
    document.getElementById('procTitle').textContent = 'Bayar ' + S.merchant;
    go('processing'); [1,2,3,4].forEach(n => pStep(n,'idle','—','—'));

    if (S.isDemo || typeof Pi === 'undefined') {
      pStep(1,'act','Pi.createPayment()','Membuat payment di Pi Network'); await wait(900);
      pStep(1,'done'); pStep(2,'act','Pi Platform approve+complete','/api/pi'); await wait(1000);
      pStep(2,'done'); pStep(3,'act','TransFi Offramp','Pi → IDR · KYC check'); await wait(1100);
      pStep(3,'done'); pStep(4,'act','Payout ke merchant','Bank/QRIS via TransFi'); await wait(800); pStep(4,'done');
      S.piSaldo = parseFloat((S.piSaldo-piT).toFixed(4));
      S.idrSaldo += Math.floor(idr); refresh();
      showSuccess({ ttl:'Pembayaran Berhasil', sub:'Rp '+fmt(idr)+' → '+S.merchant, type:'Bayar Merchant (Demo)', dest:S.merchant, pi:'-'+piT.toFixed(4)+' π', idr:'Rp '+fmt(idr), via:'Pi Network + TransFi (Demo)', tx:'demo-pay-'+Date.now() });
      return;
    }

    try {
      const payData = {
        amount: piT, memo: 'E-Kamatho — Bayar '+S.merchant+' (Rp '+fmt(idr)+')',
        metadata: { type:'payment', merchant:S.merchant, idrAmount:idr, piAmount:piT, app:'e-kamatho-majer',
          user: { uid:S.user.uid, username:S.user.username, email:S.user.email, piKycName:S.kyc.name },
          bankAccount: { type:S.kyc.payoutType, accountNumber:S.kyc.accNum, accountName:S.kyc.accName, bankCode:S.kyc.bankCode, bankName:S.kyc.bankName },
          timestamp: new Date().toISOString() }
      };
      pStep(1,'act','Pi.createPayment()','Membuat payment di Pi Network');
      const result = await new Promise((res, rej) => {
        Pi.createPayment(payData, {
          onReadyForServerApproval: async (paymentId) => {
            pStep(1,'done'); pStep(2,'act','Pi Platform Approve','/api/pi');
            try { await callPi({ action:'approve', paymentId, uid:S.user.uid }); } catch (e) { console.warn(e); }
          },
          onReadyForServerCompletion: async (paymentId, txid) => {
            pStep(2,'done'); pStep(3,'act','TransFi Offramp','Pi → IDR · /api/transfi');
            try {
              const r = await callPi({ action:'complete', paymentId, txid, uid:S.user.uid, meta:{ ...payData.metadata, paymentId } });
              pStep(3,'done'); pStep(4,'act','Payout ke merchant','Bank/QRIS via TransFi');
              await wait(700); pStep(4,'done');
              const token = sessionStorage.getItem('pi_access_token');
              if (token) { await PiAuth.refreshPiBalance(); } else { S.piSaldo = parseFloat((S.piSaldo-piT).toFixed(4)); }
              S.idrSaldo += Math.floor(idr); refresh();
              res({ paymentId, txid, transfiOrder: r.transfiOrder });
            } catch (e) { rej(e); }
          },
          onCancel: () => rej(new Error('CANCELLED')),
          onError:  (e) => rej(e),
        });
      });
      showSuccess({ ttl:'Pembayaran Berhasil', sub:'Rp '+fmt(idr)+' → '+S.merchant+' via TransFi', type:'Bayar Merchant', dest:S.merchant, pi:'-'+piT.toFixed(4)+' π', idr:'Rp '+fmt(idr), via:'Pi Network + TransFi Offramp', tx: result.transfiOrder?.orderId || result.txid || 'Lihat Vercel Logs' });
    } catch (err) {
      if (err.message === 'CANCELLED') toast('Pembayaran dibatalkan');
      else toast('Pembayaran gagal: ' + (err.message || 'Error'));
      go('payment');
    }
  }
  return { exec };
})();

function calcPay(v) {
  const idr = parseFloat(v) || 0;
  if (idr <= 0) { document.getElementById('payPrev').style.display = 'none'; return; }
  const piB = idr/CFG.RATE, piT = parseFloat((piB/(1-CFG.FEE)).toFixed(4)), piF = parseFloat((piT-piB).toFixed(4));
  document.getElementById('payPrev').style.display = 'block';
  document.getElementById('payPiR').textContent = piT.toFixed(4);
  document.getElementById('payDtl').textContent = 'Rp '+fmt(idr)+' ÷ Rp 14.000/π + fee 2%';
  document.getElementById('pfIDR').textContent  = 'Rp '+fmt(idr);
  document.getElementById('pfPi').textContent   = piB.toFixed(4)+' π';
  document.getElementById('pfFee').textContent  = piF.toFixed(4)+' π';
  document.getElementById('pfTot').textContent  = piT.toFixed(4)+' π';
  document.getElementById('pfAft').textContent  = (S.piSaldo-piT).toFixed(4)+' π';
}
function selMP(el, name) {
  S.merchant = name;
  document.querySelectorAll('.merch-opt').forEach(m => m.classList.remove('on'));
  el.classList.add('on');
}
