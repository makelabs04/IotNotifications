/**
 * poller.js
 * Polls the database every POLL_INTERVAL_MS, checks each channel's latest
 * sensor reading against configured min/max thresholds, and sends Web Push
 * notifications to subscribed browsers when a threshold is breached.
 */
require('dotenv').config();
const webpush  = require('web-push');
const db       = require('./db');

const POLL_MS        = parseInt(process.env.POLL_INTERVAL_MS || '30000');
const COOLDOWN_MIN   = parseInt(process.env.ALERT_COOLDOWN_MIN || '5');
const DASHBOARD_URL  = process.env.DASHBOARD_URL || 'https://relaycontrol.makelearners.com';

// In-memory cooldown map: "channelId:fieldNum" -> last alert timestamp
const lastAlerted = new Map();

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function isCooledDown(key) {
  if (!lastAlerted.has(key)) return true;
  const diffMs = Date.now() - lastAlerted.get(key);
  return diffMs > COOLDOWN_MIN * 60 * 1000;
}

function markAlerted(key) {
  lastAlerted.set(key, Date.now());
}

async function getChannelsWithThresholds() {
  const [rows] = await db.execute(`
    SELECT
      id, name, channel_id, user_id,
      field1_name, field1_min, field1_max,
      field2_name, field2_min, field2_max,
      field3_name, field3_min, field3_max,
      field4_name, field4_min, field4_max,
      field5_name, field5_min, field5_max,
      field6_name, field6_min, field6_max,
      field7_name, field7_min, field7_max,
      field8_name, field8_min, field8_max
    FROM channels
    WHERE
      field1_min IS NOT NULL OR field1_max IS NOT NULL OR
      field2_min IS NOT NULL OR field2_max IS NOT NULL OR
      field3_min IS NOT NULL OR field3_max IS NOT NULL OR
      field4_min IS NOT NULL OR field4_max IS NOT NULL OR
      field5_min IS NOT NULL OR field5_max IS NOT NULL OR
      field6_min IS NOT NULL OR field6_max IS NOT NULL OR
      field7_min IS NOT NULL OR field7_max IS NOT NULL OR
      field8_min IS NOT NULL OR field8_max IS NOT NULL
  `);
  return rows;
}

async function getLatestData(channelDbId) {
  const [rows] = await db.execute(`
    SELECT field1, field2, field3, field4,
           field5, field6, field7, field8, timestamp
    FROM channel_data
    WHERE channel_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `, [channelDbId]);
  return rows[0] || null;
}

async function getSubscriptionsForUser(userId, channelDbId) {
  // Get all subscriptions for this user where channel is in their channel_ids list (or all)
  const [rows] = await db.execute(`
    SELECT endpoint, p256dh, auth_key, channel_ids
    FROM push_subscriptions
    WHERE user_id = ?
  `, [userId]);

  return rows.filter(sub => {
    if (!sub.channel_ids) return true; // subscribed to all channels
    try {
      const ids = JSON.parse(sub.channel_ids);
      return ids.includes(channelDbId);
    } catch (e) {
      return true;
    }
  });
}

async function sendNotification(sub, payload) {
  const pushSub = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth_key }
  };
  try {
    await webpush.sendNotification(pushSub, JSON.stringify(payload));
    console.log('[push] Sent to', sub.endpoint.slice(-30));
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Subscription expired — remove it
      console.log('[push] Expired subscription removed');
      await db.execute('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
    } else {
      console.error('[push] Error:', err.message);
    }
  }
}

async function pollAndNotify() {
  try {
    const channels = await getChannelsWithThresholds();

    for (const ch of channels) {
      const latest = await getLatestData(ch.id);
      if (!latest) continue;

      const subs = await getSubscriptionsForUser(ch.user_id, ch.id);
      if (!subs.length) continue;

      for (let i = 1; i <= 8; i++) {
        const fieldName = ch[`field${i}_name`];
        if (!fieldName) continue;

        const minVal   = ch[`field${i}_min`] !== null ? parseFloat(ch[`field${i}_min`]) : null;
        const maxVal   = ch[`field${i}_max`] !== null ? parseFloat(ch[`field${i}_max`]) : null;
        const current  = latest[`field${i}`] !== null ? parseFloat(latest[`field${i}`]) : null;

        if (current === null || (minVal === null && maxVal === null)) continue;

        let breached   = false;
        let direction  = '';
        let limitVal   = null;

        if (minVal !== null && current < minVal) {
          breached  = true;
          direction = 'below minimum';
          limitVal  = minVal;
        } else if (maxVal !== null && current > maxVal) {
          breached  = true;
          direction = 'above maximum';
          limitVal  = maxVal;
        }

        if (!breached) continue;

        const alertKey = `${ch.id}:field${i}`;
        if (!isCooledDown(alertKey)) continue;

        markAlerted(alertKey);

        const payload = {
          title:   `⚠️ ${ch.name} Alert`,
          body:    `${fieldName}: ${current.toFixed(2)} is ${direction} (limit: ${limitVal})`,
          icon:    `${DASHBOARD_URL}/assets/icon-192.png`,
          badge:   `${DASHBOARD_URL}/assets/badge-72.png`,
          url:     `${DASHBOARD_URL}/dashboard.php?channel=${ch.id}`,
          channel: ch.name,
          field:   fieldName,
          value:   current,
          limit:   limitVal,
          type:    direction.includes('below') ? 'MIN_BREACH' : 'MAX_BREACH',
          ts:      new Date().toISOString(),
        };

        console.log(`[alert] ${ch.name} → ${fieldName} = ${current} (${direction} ${limitVal})`);

        for (const sub of subs) {
          await sendNotification(sub, payload);
        }
      }
    }
  } catch (err) {
    console.error('[poller] Error during poll:', err.message);
  }
}

function start() {
  console.log(`[poller] Started. Polling every ${POLL_MS / 1000}s, cooldown ${COOLDOWN_MIN}min`);
  pollAndNotify(); // immediate first run
  setInterval(pollAndNotify, POLL_MS);
}

module.exports = { start };
