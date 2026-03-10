/**
 * routes/subscribe.js
 * POST   /api/subscribe              — save browser push subscription
 * DELETE /api/subscribe              — remove subscription
 * GET    /api/subscribe/vapid-public-key — return VAPID public key
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ── POST /api/subscribe ───────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { subscription, user_id, channel_ids, source } = req.body;

    if (!subscription || !subscription.endpoint)
      return res.status(400).json({ error: 'Missing subscription object' });
    if (!user_id)
      return res.status(400).json({ error: 'Missing user_id' });

    const endpoint   = subscription.endpoint;
    const p256dh     = subscription.keys?.p256dh  ?? null;
    const auth_key   = subscription.keys?.auth     ?? null;
    const channels   = Array.isArray(channel_ids) ? JSON.stringify(channel_ids) : null;
    const src        = source || 'industrycontrol';   // tag which dashboard subscribed

    await db.execute(
      `INSERT INTO push_subscriptions
         (user_id, endpoint, p256dh, auth_key, channel_ids, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         user_id     = VALUES(user_id),
         p256dh      = VALUES(p256dh),
         auth_key    = VALUES(auth_key),
         channel_ids = VALUES(channel_ids),
         source      = VALUES(source),
         updated_at  = NOW()`,
      [user_id, endpoint, p256dh, auth_key, channels, src]
    );

    console.log(`[subscribe] Saved for user_id=${user_id} source=${src}`);
    return res.json({ success: true, message: 'Subscription saved' });

  } catch (err) {
    console.error('[subscribe POST]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/subscribe ─────────────────────────────────────────
router.delete('/', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint)
      return res.status(400).json({ error: 'Missing endpoint' });

    await db.execute(
      'DELETE FROM push_subscriptions WHERE endpoint = ?',
      [endpoint]
    );
    return res.json({ success: true, message: 'Unsubscribed' });

  } catch (err) {
    console.error('[subscribe DELETE]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/subscribe/vapid-public-key ───────────────────────────
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

module.exports = router;
