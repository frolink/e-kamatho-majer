/**
 * POST /api/webhook
 * Endpoint server-to-server yang dipanggil LANGSUNG oleh TransFi.
 *
 * Fase 3 dari arsitektur Ekamatho — pengguna tidak pernah menyentuh
 * endpoint ini. TransFi mengirim notifikasi settlement ke sini, lalu:
 *
 *   Kasus A — Konversi Pi→IDR (dari /api/convert):
 *     fund_settled → idrBalance bertambah, catat transaksi.
 *     (piBalance sudah dikurangi saat initiate, jadi tidak diubah lagi.)
 *
 *   Kasus B — Payout ke merchant (dari /api/merchant):
 *     failed/expired → kembalikan idrBalance, update status payout.
 *
 *   Kasus C — Withdrawal ke rekening bank (dari /api/withdraw):
 *     failed/expired → kembalikan idrBalance, update status withdrawal.
 *
 * Daftarkan URL https://<domain>/api/webhook di dashboard TransFi kamu.
 */
const transfiClient  = require('../services/transfiClient');
const store          = require('../services/store');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rawBody = await readRawBody(req);

    // Verifikasi signature HMAC dari TransFi — cegah webhook palsu
    const signature = req.headers['x-transfi-signature'];
    if (!transfiClient.verifyWebhookSignature(rawBody, signature)) {
      console.warn('[webhook] Signature tidak valid — request diabaikan');
      return res.status(401).json({ error: 'Signature tidak valid' });
    }

    const payload        = JSON.parse(rawBody.toString('utf-8'));
    const order          = payload.order || {};
    const status         = payload.status || order.status;
    const entityId       = payload.entityId || order.orderId;
    const customerOrderId = order.customerOrderId;

    console.log('[webhook] TransFi event:', { entityId, status, customerOrderId });

    // ── Kasus A: Konversi Pi → IDR ─────────────────────────────────────
    const transfiOrder = await store.getTransfiOrder(entityId);
    if (transfiOrder) {
      await store.updateTransfiOrder(entityId, { status, lastWebhookAt: new Date().toISOString() });

      const isSettled = ['fund_settled', 'settled', 'completed'].includes(status);
      if (isSettled && transfiOrder.status !== 'credited') {
        const idrAmount = Number(order.withdrawAmount || transfiOrder.withdrawAmount || transfiOrder.estimatedIdr || 0);
        if (idrAmount > 0) {
          const newIdrBalance = await store.creditIdrBalance(transfiOrder.uid, idrAmount);
          await store.updateTransfiOrder(entityId, {
            status:     'credited',
            idrAmount,
            creditedAt: new Date().toISOString(),
          });
          await store.addTransaction({
            uid:     transfiOrder.uid,
            type:    'convert_settled',
            name:    'Konversi Pi → Rupiah (selesai)',
            amountIdr: idrAmount,
            orderId: entityId,
            convertId: transfiOrder.convertId,
            note:    'Rupiah masuk ke Dompet Rupiah kamu',
          });
          console.log(`[webhook] idrBalance user ${transfiOrder.uid} +${idrAmount} IDR → total ${newIdrBalance}`);
        }
      }

      if (['failed', 'expired'].includes(status)) {
        // Pi sudah terkirim ke TransFi tapi konversi gagal — perlu rekonsiliasi manual
        // Catat supaya admin bisa melakukan refund Pi jika memang hak user
        console.warn(`[webhook] Order konversi ${entityId} ${status} — perlu rekonsiliasi manual`);
        await store.addTransaction({
          uid:   transfiOrder.uid,
          type:  'convert_failed',
          name:  'Konversi Pi → Rupiah GAGAL',
          orderId: entityId,
          note:  `Status TransFi: ${status}. Hubungi support.`,
        });
      }

      return res.status(200).json({ received: true, handled: 'convert' });
    }

    // ── Kasus B: Payout ke merchant ─────────────────────────────────────
    const payout = await store.getPayout(customerOrderId || entityId);
    if (payout) {
      const payoutId = customerOrderId || entityId;
      if (['failed', 'expired'].includes(status) && payout.status !== 'failed') {
        await store.creditIdrBalance(payout.uid, payout.amountIdr);
        await store.updatePayout(payoutId, { status: 'failed' });
        await store.addTransaction({
          uid:      payout.uid,
          type:     'merchant_refund',
          name:     'Pembayaran merchant GAGAL — saldo dikembalikan',
          amountIdr: payout.amountIdr,
          payoutId,
        });
        console.warn(`[webhook] Payout ${payoutId} gagal, ${payout.amountIdr} IDR dikembalikan ke ${payout.uid}`);
      } else {
        await store.updatePayout(payoutId, { status });
      }
      return res.status(200).json({ received: true, handled: 'merchant_payout' });
    }

    // ── Kasus C: Withdrawal ke rekening bank pribadi ─────────────────────
    const withdrawal = await store.getWithdrawal(customerOrderId || entityId);
    if (withdrawal) {
      const withdrawalId = customerOrderId || entityId;
      if (['failed', 'expired'].includes(status) && withdrawal.status !== 'failed') {
        await store.creditIdrBalance(withdrawal.uid, withdrawal.amountIdr);
        await store.updateWithdrawal(withdrawalId, { status: 'failed' });
        await store.addTransaction({
          uid:      withdrawal.uid,
          type:     'withdraw_refund',
          name:     'Penarikan GAGAL — saldo dikembalikan',
          amountIdr: withdrawal.amountIdr,
          withdrawalId,
        });
        console.warn(`[webhook] Withdrawal ${withdrawalId} gagal, ${withdrawal.amountIdr} IDR dikembalikan`);
      } else {
        await store.updateWithdrawal(withdrawalId, { status });
      }
      return res.status(200).json({ received: true, handled: 'withdrawal' });
    }

    // Event tidak cocok dengan record manapun — tetap balas 200 agar
    // TransFi tidak retry terus menerus
    console.log('[webhook] Event tidak cocok dengan record lokal, diabaikan:', entityId);
    return res.status(200).json({ received: true, handled: 'ignored' });

  } catch (err) {
    console.error('[webhook] error:', err.message);
    return res.status(400).json({ error: 'Gagal memproses webhook' });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = handler;
// Matikan body parser bawaan Vercel supaya rawBody bisa dibaca utuh
// (dibutuhkan untuk verifikasi HMAC signature dari TransFi)
module.exports.config = { api: { bodyParser: false } };
