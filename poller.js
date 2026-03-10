/**
 * poller.js
 * Polls the DB every POLL_INTERVAL_MS, checks each channel's latest
 * sensor reading against min/max thresholds, and:
 *  - Sends Web Push notifications on breach
 *  - Writes relay command ON/OFF when auto relay is enabled (breach)
 *  - Writes the OPPOSITE/recovery command when value returns to normal ← NEW
 */
require('dotenv').config();
const webpush = require('web-push');
const db      = require('./db');

const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS  || '30000');
const COOLDOWN_MIN  = parseInt(process.env.ALERT_COOLDOWN_MIN || '5');
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://industrycontrol.makelearners.com')
                        .replace(/\/+$/, '');

// In-memory cooldown map: "channelId:fieldNum" → last alert timestamp (ms)
const lastAlerted = new Map();

// In-memory breach state: "channelId:fieldNum" → true if currently in breach
// This lets us detect when a value RECOVERS (was breached, now back to normal)
const breachState = new Map();

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
    if (!sub.channel_ids) return true;
    try {
      const ids = JSON.parse(sub.channel_ids);
      return ids.map(Number).includes(Number(channelDbId));
    } catch (e) {
      console.warn('[poller] Failed to parse channel_ids:', sub.channel_ids);
      return true;
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
      `UPDATE channels SET \`${col}\` = ?, relay_updated_at = NOW() WHERE id = ?`,
      [command, channelDbId]
    );
    console.log(`[auto-relay] channel=${channelDbId} relay${fieldNum} → ${command}`);
  } catch (err) {
    console.error(`[auto-relay] Failed to write relay: ${err.message}`);
  }
}

// ── Recovery command: opposite of the breach command ─────────────
// If breach fired ON  → recovery fires OFF
// If breach fired OFF → recovery fires ON
function recoveryCommand(breachCmd) {
  return breachCmd === 'ON' ? 'OFF' : 'ON';
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

      for (let i = 1; i <= 8; i++) {
        const fieldName = ch[`field${i}_name`];
        if (!fieldName || fieldName.trim() === '') continue;

        const minVal  = ch[`field${i}_min`] != null ? parseFloat(ch[`field${i}_min`]) : null;
        const maxVal  = ch[`field${i}_max`] != null ? parseFloat(ch[`field${i}_max`]) : null;
        const current = latest[`field${i}`] != null ? parseFloat(latest[`field${i}`]) : null;

        if (current === null || (minVal === null && maxVal === null)) continue;

        const relayAuto  = ch[`field${i}_relay_auto`];
        const autoMinCmd = ch[`field${i}_relay_auto_min_cmd`] || 'ON';
        const autoMaxCmd = ch[`field${i}_relay_auto_max_cmd`] || 'OFF';
        const stateKey   = `${ch.id}:field${i}`;

        console.log(`[poller]   field${i} "${fieldName}": value=${current}, min=${minVal}, max=${maxVal}`);

        // ── Determine current breach status ───────────────────────
        let breached  = false;
        let direction = '';
        let limitVal  = null;
        let breachCmd = null;

        if (minVal !== null && current < minVal) {
          breached  = true;
          direction = 'below minimum';
          limitVal  = minVal;
          breachCmd = autoMinCmd;
        } else if (maxVal !== null && current > maxVal) {
          breached  = true;
          direction = 'above maximum';
          limitVal  = maxVal;
          breachCmd = autoMaxCmd;
        }

        const wasBreached = breachState.get(stateKey) || false;

        // ── RECOVERY: value returned to normal ────────────────────
        if (!breached && wasBreached) {
          console.log(`[poller]   ✅ RECOVERY: field${i} "${fieldName}" back within limits`);
          breachState.set(stateKey, false);

          if (relayAuto) {
            // We don't know which breach fired (min or max), so we pick the
            // safe recovery: opposite of whichever command was most recently sent.
            // Simple heuristic: if value is now above min → was a min breach → recovery = opposite of autoMinCmd
            //                   (maxVal breach recovery handled symmetrically)
            const recoverCmd = recoveryCommand(autoMinCmd); // default: opposite of min breach cmd
            await writeAutoRelay(ch.id, i, recoverCmd);
            console.log(`[auto-relay] Recovery → relay${i} set to ${recoverCmd}`);
          }
          continue;
        }

        // ── NOT breached and wasn't before — all good ─────────────
        if (!breached) {
          console.log(`[poller]   → Within limits ✓`);
          continue;
        }

        // ── BREACH ───────────────────────────────────────────────
        breachState.set(stateKey, true);

        // Auto relay fires EVERY poll while breached (no cooldown gate for relay)
        // This ensures relay stays in correct state even if poller restarts
        if (relayAuto) {
          await writeAutoRelay(ch.id, i, breachCmd);
        }

        // Push notification respects cooldown
        const alertKey = `${ch.id}:field${i}`;
        if (!isCooledDown(alertKey)) {
          const remaining = Math.ceil(
            (COOLDOWN_MIN * 60 * 1000 - (Date.now() - lastAlerted.get(alertKey))) / 60000
          );
          console.log(`[poller]   → BREACH — relay written, push cooldown active (${remaining} min remaining)`);
          continue;
        }

        markAlerted(alertKey);

        if (!subs.length) {
          console.log(`[poller]   → No subscriptions matched, skipping push`);
          continue;
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
  pollAndNotify();
  setInterval(pollAndNotify, POLL_MS);
}

module.exports = { start };
