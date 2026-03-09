# IoT Push Notifier — Node.js Server

Sends Chrome/browser push notifications to users when sensor values breach
configured `min`/`max` thresholds in your RelayControl IoT dashboard.

---

## Architecture

```
[ESP32 devices] → [PHP dashboard (relaycontrol.makelearners.com)]
                         │  (shared MySQL DB)
                  [Node.js notify server] ──→ [User Browser (Chrome push)]
```

Both the PHP dashboard and this Node server read the **same** MySQL database.

---

## Setup Steps

### 1. Run the SQL migration (once)
Import `migration.sql` into your existing database:
```bash
mysql -u u966260443_root -p u966260443_relaycontrol < migration.sql
```

### 2. Install dependencies
```bash
npm install
```

### 3. Generate VAPID keys (once)
```bash
node generate-vapid.js
```
Copy the two keys printed to your terminal.

### 4. Configure `.env`
```bash
cp .env.example .env
nano .env
```
Fill in:
- DB credentials (same as your PHP `config.php`)
- The VAPID keys you just generated
- `DASHBOARD_URL` = your PHP dashboard URL
- `ALLOWED_ORIGINS` = your PHP dashboard domain

### 5. Copy client files to PHP dashboard
| File | Destination on PHP server |
|------|--------------------------|
| `public/sw.js` | `/sw.js` (domain root — **must be at root**) |
| `public/push-client.js` | `/assets/js/push-client.js` |

### 6. Edit dashboard.php (two small additions)
See `dashboard_patch.php` for exact copy-paste snippets.

**In `<head>`:**
```html
<script src="/assets/js/push-client.js"></script>
```

**Before `</body>`:**
```html
<script>
document.addEventListener('DOMContentLoaded', function () {
    var userId    = <?= intval($_SESSION['user_id'] ?? 0) ?>;
    var channelId = <?= isset($selected_channel) ? intval($selected_channel['id']) : 'null' ?>;
    if (userId) {
        IotPush.init({ userId: userId, channelIds: channelId ? [channelId] : [] });
    }
});
</script>
```

**Inside `push-client.js`**, set `NODE_SERVER_URL` to your Node server's URL:
```js
const NODE_SERVER_URL = 'https://YOUR-NODE-SERVER.com';
```

### 7. Start the server

**Hostinger Node.js hosting:**
- Set entry file to `server.js`
- Add environment variables in Hostinger panel (or use `.env`)
- Start

**PM2 (if SSH access):**
```bash
npm install -g pm2
pm2 start server.js --name iot-push
pm2 save
pm2 startup
```

---

## How it works

| Step | What happens |
|------|-------------|
| User visits dashboard | `push-client.js` loads, shows "Enable Alerts" banner |
| User clicks Allow | Browser grants permission, subscribes via Push API, subscription saved to `push_subscriptions` table |
| ESP32 sends data | Sensor values land in `channel_data` table |
| Node poller runs (every 30s) | Reads latest row per channel, compares field values to `field1_min/max` … `field8_min/max` |
| Threshold breached | Node calls `webpush.sendNotification()` for all subscribers |
| Browser receives push | Service worker `sw.js` shows notification with "View Dashboard" button |
| User clicks notification | Browser opens/focuses dashboard at the relevant channel |

---

## Configuration

| `.env` key | Default | Description |
|-----------|---------|-------------|
| `POLL_INTERVAL_MS` | `30000` | How often to check (ms) |
| `ALERT_COOLDOWN_MIN` | `5` | Minutes between repeat alerts for same field |
| `DASHBOARD_URL` | — | Your PHP dashboard base URL |
| `ALLOWED_ORIGINS` | — | Comma-separated origins for CORS |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/subscribe/vapid-public-key` | Returns VAPID public key |
| `POST` | `/api/subscribe` | Save browser subscription |
| `DELETE` | `/api/subscribe` | Remove subscription |

---

## File Structure

```
iot-push-notifier/
├── server.js           ← Express entry point
├── poller.js           ← Threshold checker + push sender
├── db.js               ← MySQL pool (shared DB)
├── generate-vapid.js   ← Run once to make VAPID keys
├── .env.example        ← Copy to .env and fill in
├── routes/
│   └── subscribe.js    ← /api/subscribe endpoints
└── public/
    ├── sw.js           ← Service Worker (copy to PHP domain root)
    └── push-client.js  ← Client JS (copy to PHP assets/)

dashboard-patch/
├── migration.sql       ← Run once on existing DB
└── dashboard_patch.php ← Shows exactly what to add to dashboard.php
```
