/**
 * push-client.js — Include this in your PHP dashboard HTML
 * Place at: /assets/js/push-client.js  (or wherever you prefer)
 *
 * Usage in dashboard.php (add before </body>):
 *   <script src="/assets/js/push-client.js"></script>
 *   <script>
 *     IotPush.init({ userId: <?= $_SESSION['user_id'] ?>, channelIds: [<?= $selected_channel['id'] ?? '' ?>] });
 *   </script>
 */

(function(window) {
  'use strict';

  // ── CONFIGURE THIS URL to point to your Node.js server ──────────
  const NODE_SERVER_URL = 'https://iotnotify.makelearners.com/'; // e.g. https://notify.makelearners.com:3000

  const IotPush = {
    _userId:     null,
    _channelIds: [],
    _sw:         null,
    _sub:        null,

    /**
     * Call this once the page loads.
     * @param {object} opts  { userId: number, channelIds: number[] }
     */
    async init(opts) {
      this._userId     = opts.userId     || null;
      this._channelIds = opts.channelIds || [];

      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('[IotPush] Push not supported in this browser.');
        return;
      }
      if (!this._userId) {
        console.warn('[IotPush] No userId supplied — notifications disabled.');
        return;
      }

      // Register service worker (must be at dashboard root domain)
      try {
        this._sw = await navigator.serviceWorker.register('/sw.js');
        console.log('[IotPush] Service worker registered.');
      } catch (err) {
        console.error('[IotPush] SW registration failed:', err);
        return;
      }

      // Show permission prompt banner if not yet decided
      const perm = Notification.permission;
      if (perm === 'granted') {
        await this._subscribe();
      } else if (perm === 'default') {
        this._showPermissionBanner();
      }
      // 'denied' — do nothing silently
    },

    _showPermissionBanner() {
      if (document.getElementById('iot-push-banner')) return; // already shown

      const banner = document.createElement('div');
      banner.id    = 'iot-push-banner';
      banner.style.cssText = [
        'position:fixed','bottom:20px','right:20px','z-index:9999',
        'background:linear-gradient(135deg,#667eea,#764ba2)',
        'color:#fff','border-radius:16px','padding:16px 20px',
        'max-width:340px','box-shadow:0 8px 32px rgba(0,0,0,.25)',
        'font-family:sans-serif','font-size:14px','line-height:1.5',
        'animation:iot-slide-in .4s ease',
      ].join(';');

      banner.innerHTML = `
        <style>
          @keyframes iot-slide-in {
            from { transform: translateY(80px); opacity: 0; }
            to   { transform: translateY(0);    opacity: 1; }
          }
        </style>
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <span style="font-size:28px;flex-shrink:0;">🔔</span>
          <div>
            <div style="font-weight:700;font-size:15px;margin-bottom:4px;">Enable Sensor Alerts</div>
            <div style="opacity:.9;font-size:13px;">Get instant browser notifications when your sensor values go beyond configured thresholds.</div>
            <div style="display:flex;gap:8px;margin-top:12px;">
              <button id="iot-push-allow" style="background:#fff;color:#667eea;border:none;border-radius:8px;padding:7px 18px;font-weight:700;cursor:pointer;font-size:13px;">Allow</button>
              <button id="iot-push-deny"  style="background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:7px 14px;cursor:pointer;font-size:13px;">Not now</button>
            </div>
          </div>
        </div>`;

      document.body.appendChild(banner);

      document.getElementById('iot-push-allow').addEventListener('click', async () => {
        banner.remove();
        const perm = await Notification.requestPermission();
        if (perm === 'granted') await this._subscribe();
      });
      document.getElementById('iot-push-deny').addEventListener('click', () => banner.remove());
    },

    async _getVapidKey() {
      const res  = await fetch(`${NODE_SERVER_URL}/api/subscribe/vapid-public-key`);
      const data = await res.json();
      return data.publicKey;
    },

    _urlBase64ToUint8Array(base64String) {
      const padding  = '='.repeat((4 - base64String.length % 4) % 4);
      const b64      = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw      = window.atob(b64);
      const output   = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
      return output;
    },

    async _subscribe() {
      try {
        await navigator.serviceWorker.ready;
        const existing = await this._sw.pushManager.getSubscription();
        if (existing) {
          this._sub = existing;
          await this._saveToServer(existing);
          return;
        }
        const vapidKey     = await this._getVapidKey();
        const subscription = await this._sw.pushManager.subscribe({
          userVisibleOnly:      true,
          applicationServerKey: this._urlBase64ToUint8Array(vapidKey),
        });
        this._sub = subscription;
        await this._saveToServer(subscription);
        console.log('[IotPush] Subscribed successfully.');
      } catch (err) {
        console.error('[IotPush] Subscribe failed:', err);
      }
    },

    async _saveToServer(subscription) {
      try {
        const res = await fetch(`${NODE_SERVER_URL}/api/subscribe`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            subscription,
            user_id:     this._userId,
            channel_ids: this._channelIds,
          }),
        });
        const data = await res.json();
        console.log('[IotPush] Server response:', data.message);
      } catch (err) {
        console.error('[IotPush] Could not save subscription:', err);
      }
    },

    async unsubscribe() {
      if (!this._sub) return;
      try {
        await fetch(`${NODE_SERVER_URL}/api/subscribe`, {
          method:  'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ endpoint: this._sub.endpoint }),
        });
        await this._sub.unsubscribe();
        this._sub = null;
        console.log('[IotPush] Unsubscribed.');
      } catch (err) {
        console.error('[IotPush] Unsubscribe failed:', err);
      }
    },
  };

  window.IotPush = IotPush;
})(window);
