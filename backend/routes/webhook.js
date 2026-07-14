/**
 * POST /api/webhook
 * Endpoint server-to-server yang dipanggil LANGSUNG oleh TransFi (bukan
 * oleh browser user) — inilah yang membuat status settlement tidak bisa
 * dipalsukan dari client. Daftarkan URL ini di dashboard webhook TransFi.
 *
 * Menangani dua jenis event (dibedakan lewat entityType/order.type sesuai
 * skema webhook TransFi):
 *   - Order Offramp (Top Up Pi->IDR): saat status settle -> kredit saldo
 *     Rupiah user terkait (dicari lewat customerOrderId = paymentId Pi).
 *   - Payout (Bayar Merchant): saat status settle/gagal -> update status
 *     payout tersimpan (saldo sudah didebit di muka oleh api/merchant.js).
 *
 * Body parser bawaan dimatikan (lihat `config` di bawah) supaya kita bisa
 * membaca raw body untuk verifikasi signature HMAC.
 */
const transfiClient = require('../services/transfiClient');
const store = require('../services/store');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rawBody = await readRawBody(req);
    // ⚠️ Sesuaikan nama header ini dengan pengaturan webhook di dashboard TransFi kamu.
    const signature = req.headers['x-transfi-signature'];
    if (!transfiClient.verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Signature tidak valid' });
    }

    const payload = JSON.parse(rawBody.toString('utf-8'));
    const order = payload.order || {};
    const status = payload.status || order.status;
    const entityId = payload.entityId || order.orderId;
    const customerOrderId = order.customerOrderId;

    console.log('Webhook TransFi diterima:', { entityId, status, customerOrderId });

    // ---- Kasus 1: order Offramp Top Up (Pi -> IDR) ----
    const transfiOrder = await store.getTransfiOrder(entityId);
    if (transfiOrder) {
      await store.updateTransfiOrder(entityId, { status, lastWebhookPayload: payload });

      const isSettled = status === 'fund_settled' || status === 'settled' || status === 'completed';
      if (isSettled && transfiOrder.status !== 'credited') {
        const withdrawAmount = Number(order.withdrawAmount || transfiOrder.withdrawAmount || 0);
        if (withdrawAmount > 0) {
          const newBalance = await store.creditAppBalance(transfiOrder.uid, withdrawAmount);
          await store.updateTransfiOrder(entityId, { status: 'credited', withdrawAmount, creditedAt: new Date().toISOString() });
          await store.addTransaction({
            uid: transfiOrder.uid, type: 'topup', name: 'Top Up Pi (settled via TransFi)',
            badge: 'TransFi Offramp', amountIdr: withdrawAmount, orderId: entityId
          });
          console.log(`Saldo Rupiah user ${transfiOrder.uid} bertambah ${withdrawAmount} IDR, total kini ${newBalance}`);
        }
      }
      if (status === 'failed' || status === 'expired') {
        await store.updateTransfiOrder(entityId, { status });
        console.warn(`Order Offramp ${entityId} berstatus ${status} — Pi tidak terkonversi, perlu ditinjau manual.`);
      }
      return res.status(200).json({ received: true, handled: 'transfi_order' });
    }

    // ---- Kasus 2: payout ke merchant ----
    const payout = await store.getPayout(customerOrderId || entityId);
    if (payout) {
      const payoutId = customerOrderId || entityId;
      if (status === 'failed' || status === 'expired') {
        // Payout gagal setelah saldo sudah didebit di muka -> kembalikan saldo.
        if (payout.status !== 'failed') {
          await store.creditAppBalance(payout.uid, payout.amountIdr);
          await store.updatePayout(payoutId, { status: 'failed' });
          console.warn(`Payout ${payoutId} gagal, saldo ${payout.amountIdr} IDR dikembalikan ke user ${payout.uid}`);
        }
      } else {
        await store.updatePayout(payoutId, { status });
      }
      return res.status(200).json({ received: true, handled: 'payout' });
    }

    // ---- Kasus 3: penarikan ke rekening bank pribadi ----
    const withdrawal = await store.getWithdrawal(customerOrderId || entityId);
    if (withdrawal) {
      const withdrawalId = customerOrderId || entityId;
      if (status === 'failed' || status === 'expired') {
        if (withdrawal.status !== 'failed') {
          await store.creditAppBalance(withdrawal.uid, withdrawal.amountIdr);
          await store.updateWithdrawal(withdrawalId, { status: 'failed' });
          console.warn(`Penarikan ${withdrawalId} gagal, saldo ${withdrawal.amountIdr} IDR dikembalikan ke user ${withdrawal.uid}`);
        }
      } else {
        await store.updateWithdrawal(withdrawalId, { status });
      }
      return res.status(200).json({ received: true, handled: 'withdrawal' });
    }

    // Event tidak dikenali/tidak cocok dengan order manapun di ledger kita
    return res.status(200).json({ received: true, handled: 'ignored' });
  } catch (err) {
    console.error('api/webhook error:', err.message);
    return res.status(400).json({ error: 'Gagal memproses webhook' });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = handler;
// Matikan body parser bawaan Vercel supaya rawBody di atas bisa dibaca utuh
// (dibutuhkan untuk verifikasi HMAC signature).
module.exports.config = { api: { bodyParser: false } };
