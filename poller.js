/**
 * poller.js
 * Polls the DB every POLL_INTERVAL_MS, checks each channel's latest
 * sensor reading against min/max thresholds, and sends Web Push
 * notifications when a threshold is breached.
 */
require('dotenv').config();
const webpush = require('web-push');
const db      = require('./db');

const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS  || '30000');
const COOLDOWN_MIN  = parseInt(process.env.ALERT_COOLDOWN_MIN || '5');
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://industrycontrol.makelearners.com')
                        .replace(/\/+$/, '');   // strip trailing slash

// In-memory cooldown map: "channelId:fieldNum" → last alert timestamp (ms)
const lastAlerted = new Map();

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Cooldown helpers ──────────────────────────────────────────────
function isCooledDown(key) {
  if (!lastAlerted.has(key)) return true;
  return (Date.now() - lastAlerted.get(key)) > COOLDOWN_MIN * 60 * 1000;
}
function markAlerted(key) {
  lastAlerted.set(key, Date.now());
}

// ── DB queries ────────────────────────────────────────────────────
async function getChannelsWithThresholds() {
  const [rows] = await db.execute(`
    SELECT
      id, name, channel_id, user_id,
      field1_name, field1_min, field1_max, field1_relay_auto, field1_relay_auto_min_cmd, field1_relay_auto_max_cmd,
      field2_name, field2_min, field2_max, field2_relay_auto, field2_relay_auto_min_cmd, field2_relay_auto_max_cmd,
      field3_name, field3_min, field3_max, field3_relay_auto, field3_relay_auto_min_cmd, field3_relay_auto_max_cmd,
      field4_name, field4_min, field4_max, field4_relay_auto, field4_relay_auto_min_cmd, field4_relay_auto_max_cmd,
      field5_name, field5_min, field5_max, field5_relay_auto, field5_relay_auto_min_cmd, field5_relay_auto_max_cmd,
      field6_name, field6_min, field6_max, field6_relay_auto, field6_relay_auto_min_cmd, field6_relay_auto_max_cmd,
      field7_name, field7_min, field7_max, field7_relay_auto, field7_relay_auto_min_cmd, field7_relay_auto_max_cmd,
      field8_name, field8_min, field8_max, field8_relay_auto, field8_relay_auto_min_cmd, field8_relay_auto_max_cmd
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
  console.log(`[poller] Found ${rows.length} channel(s) with thresholds configured`);
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
  const [rows] = await db.execute(`
    SELECT endpoint, p256dh, auth_key, channel_ids
    FROM push_subscriptions
    WHERE user_id = ?
  `, [userId]);

  console.log(`[poller] user_id=${userId} channel=${channelDbId} → ${rows.length} raw subscription(s) found`);

  const matched = rows.filter(sub => {
    // NULL channel_ids means subscribed to ALL channels
    if (!sub.channel_ids) return true;
    try {
      const ids = JSON.parse(sub.channel_ids);
      // ── IMPORTANT: compare as numbers on both sides ──────────────
      // channel_ids stored as JSON array of numbers e.g. [2]
      // channelDbId comes from MySQL as a number too, but coerce both to be safe
      return ids.map(Number).includes(Number(channelDbId));
    } catch (e) {
      console.warn('[poller] Failed to parse channel_ids:', sub.channel_ids);
      return true; // if malformed, include it
    }
  });

  console.log(`[poller] → ${matched.length} matching subscription(s) for channel ${channelDbId}`);
  return matched;
}

// ── Web Push sender ───────────────────────────────────────────────
async function sendNotification(sub, payload) {
  const pushSub = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth_key }
  };
  try {
    await webpush.sendNotification(pushSub, JSON.stringify(payload));
    console.log('[push] ✅ Sent to ...', sub.endpoint.slice(-40));
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.log('[push] ⚠️  Subscription expired — removing from DB');
      await db.execute('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
    } else {
      console.error('[push] ❌ Send error:', err.statusCode, err.message);
    }
  }
}


// ── Auto Relay Writer ─────────────────────────────────────────────
async function writeAutoRelay(channelDbId, fieldNum, command) {
  const col = `relay${fieldNum}_command`;
  try {
    await db.execute(
      `UPDATE channels SET ${col} = ? WHERE id = ?`,
      [command, channelDbId]
    );
    console.log(`[auto-relay] channel=${channelDbId} relay${fieldNum} → ${command} (written to DB)`);
  } catch (err) {
    console.error(`[auto-relay] Failed to write relay: ${err.message}`);
  }
}

// ── Main poll loop ────────────────────────────────────────────────
async function pollAndNotify() {
  console.log(`\n[poller] ── Poll run at ${new Date().toISOString()} ──`);
  try {
    const channels = await getChannelsWithThresholds();

    for (const ch of channels) {
      console.log(`[poller] Checking channel: "${ch.name}" (id=${ch.id}, user_id=${ch.user_id})`);

      const latest = await getLatestData(ch.id);
      if (!latest) {
        console.log(`[poller]   → No data rows yet, skipping`);
        continue;
      }
      console.log(`[poller]   → Latest data timestamp: ${latest.timestamp}`);

      const subs = await getSubscriptionsForUser(ch.user_id, ch.id);
      if (!subs.length) {
        console.log(`[poller]   → No subscriptions matched, skipping`);
        continue;
      }

      for (let i = 1; i <= 8; i++) {
        const fieldName = ch[`field${i}_name`];
        if (!fieldName || fieldName.trim() === '') continue;

        const minVal  = ch[`field${i}_min`]  != null ? parseFloat(ch[`field${i}_min`])  : null;
        const maxVal  = ch[`field${i}_max`]  != null ? parseFloat(ch[`field${i}_max`])  : null;
        const current = latest[`field${i}`]  != null ? parseFloat(latest[`field${i}`])  : null;

        if (current === null || (minVal === null && maxVal === null)) continue;

        console.log(`[poller]   field${i} "${fieldName}": value=${current}, min=${minVal}, max=${maxVal}`);

        let breached  = false;
        let direction = '';
        let limitVal  = null;

        if (minVal !== null && current < minVal) {
          breached  = true;
          direction = 'below minimum';
          limitVal  = minVal;
        } else if (maxVal !== null && current > maxVal) {
          breached  = true;
          direction = 'above maximum';
          limitVal  = maxVal;
        }

        if (!breached) {
          console.log(`[poller]   → Within limits ✓`);
          continue;
        }

        const alertKey = `${ch.id}:field${i}`;
        if (!isCooledDown(alertKey)) {
          const remaining = Math.ceil(
            (COOLDOWN_MIN * 60 * 1000 - (Date.now() - lastAlerted.get(alertKey))) / 60000
          );
          console.log(`[poller]   → BREACH but cooldown active (${remaining} min remaining), skipping`);
          continue;
        }

        markAlerted(alertKey);

        // ── Auto relay: write command to DB if enabled ──
        const relayAuto   = ch[`field${i}_relay_auto`];
        const autoMinCmd  = ch[`field${i}_relay_auto_min_cmd`] || 'ON';
        const autoMaxCmd  = ch[`field${i}_relay_auto_max_cmd`] || 'OFF';
        if (relayAuto) {
          const autoCmd = direction.includes('below') ? autoMinCmd : autoMaxCmd;
          await writeAutoRelay(ch.id, i, autoCmd);
        }

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

        console.log(`[poller]   🚨 ALERT: "${ch.name}" → field${i} "${fieldName}" = ${current} (${direction} ${limitVal})`);

        for (const sub of subs) {
          await sendNotification(sub, payload);
        }
      }
    }
  } catch (err) {
    console.error('[poller] ❌ Error during poll:', err.message);
    console.error(err.stack);
  }
}

// ── Start ─────────────────────────────────────────────────────────
function start() {
  console.log(`[poller] Started — polling every ${POLL_MS / 1000}s, cooldown ${COOLDOWN_MIN} min`);
  pollAndNotify();                      // immediate first run
  setInterval(pollAndNotify, POLL_MS);
}

module.exports = { start };
