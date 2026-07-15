/**
 * POST /api/webhook — callback server-to-server dari TransFi.
 *
 * Event yang ditangani:
 *   - Offramp (Konversi Pi→IDR): settled → creditIdrBalance
 *   - Payout (Bayar Merchant):   failed  → creditIdrBalance (rollback)
 *   - Withdrawal (Tarik):        failed  → creditIdrBalance (rollback)
 */
const transfiClient = require('../backend/services/transfiClient');
const store = require('../backend/services/store');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rawBody  = await readRawBody(req);
    const signature = req.headers['x-transfi-signature'];
    if (!transfiClient.verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Signature tidak valid' });
    }

    const payload        = JSON.parse(rawBody.toString('utf-8'));
    const order          = payload.order || {};
    const status         = payload.status || order.status;
    const entityId       = payload.entityId || order.orderId;
    const customerOrderId = order.customerOrderId;

    console.log('[webhook] diterima:', { entityId, status, customerOrderId });

    // ── Kasus 1: Offramp (Konversi Pi→IDR) ─────────────────────────────────
    const transfiOrder = await store.getTransfiOrder(entityId);
    if (transfiOrder) {
      await store.updateTransfiOrder(entityId, { status, lastWebhookPayload: payload });
      const isSettled = ['fund_settled','settled','completed'].includes(status);
      if (isSettled && transfiOrder.status !== 'credited') {
        const withdrawAmount = Number(order.withdrawAmount || transfiOrder.withdrawAmount || 0);
        if (withdrawAmount > 0) {
          const newBalance = await store.creditIdrBalance(transfiOrder.uid, withdrawAmount);
          await store.updateTransfiOrder(entityId, { status:'credited', withdrawAmount, creditedAt: new Date().toISOString() });
          await store.addTransaction({
            uid: transfiOrder.uid, type:'convert_settled', name:'Pi → Rupiah (settled)',
            badge:'TransFi Offramp', amountIdr: withdrawAmount, orderId: entityId,
          });
          console.log('[webhook] idrBalance user', transfiOrder.uid, 'bertambah', withdrawAmount, '→ total', newBalance);
        }
      }
      if (['failed','expired'].includes(status)) {
        // Kembalikan piBalance
        if (transfiOrder.depositAmount) await store.creditPiBalance(transfiOrder.uid, transfiOrder.depositAmount);
        await store.updateTransfiOrder(entityId, { status });
        console.warn('[webhook] Offramp', entityId, status, '— piBalance dikembalikan');
      }
      return res.status(200).json({ received: true, handled: 'offramp' });
    }

    // ── Kasus 2: Payout ke merchant ─────────────────────────────────────────
    const payout = await store.getPayout(customerOrderId || entityId);
    if (payout) {
      const payoutId = customerOrderId || entityId;
      if (['failed','expired'].includes(status) && payout.status !== 'failed') {
        await store.creditIdrBalance(payout.uid, payout.amountIdr);
        await store.updatePayout(payoutId, { status:'failed' });
        console.warn('[webhook] Payout', payoutId, 'gagal — idrBalance dikembalikan');
      } else {
        await store.updatePayout(payoutId, { status });
      }
      return res.status(200).json({ received: true, handled: 'payout' });
    }

    // ── Kasus 3: Withdrawal ke rekening bank ─────────────────────────────────
    const withdrawal = await store.getWithdrawal(customerOrderId || entityId);
    if (withdrawal) {
      const withdrawalId = customerOrderId || entityId;
      if (['failed','expired'].includes(status) && withdrawal.status !== 'failed') {
        await store.creditIdrBalance(withdrawal.uid, withdrawal.amountIdr);
        await store.updateWithdrawal(withdrawalId, { status:'failed' });
        console.warn('[webhook] Withdrawal', withdrawalId, 'gagal — idrBalance dikembalikan');
      } else {
        await store.updateWithdrawal(withdrawalId, { status });
      }
      return res.status(200).json({ received: true, handled: 'withdrawal' });
    }

    return res.status(200).json({ received: true, handled: 'ignored' });
  } catch (err) {
    console.error('[webhook] error:', err.message);
    return res.status(400).json({ error: 'Gagal memproses webhook' });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
