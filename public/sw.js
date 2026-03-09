/**
 * sw.js — Service Worker for IoT Push Notifications
 * Place this file at the ROOT of your PHP dashboard domain:
 *   https://relaycontrol.makelearners.com/sw.js
 */

const CACHE_NAME = 'iot-notifier-v1';

// Install
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Push event ────────────────────────────────────────────────────
self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}

  const title   = data.title   || '⚠️ IoT Alert';
  const body    = data.body    || 'A sensor threshold has been breached.';
  const icon    = data.icon    || '/assets/icon-192.png';
  const badge   = data.badge   || '/assets/badge-72.png';
  const url     = data.url     || '/dashboard.php';

  const options = {
    body,
    icon,
    badge,
    tag:              'iot-alert-' + (data.field || 'general'),
    renotify:         true,
    requireInteraction: true,
    vibrate:          [200, 100, 200],
    data:             { url },
    actions: [
      { action: 'open',    title: '📊 View Dashboard' },
      { action: 'dismiss', title: '✕ Dismiss' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click ────────────────────────────────────────────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/dashboard.php';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      // If dashboard already open, focus it
      for (const client of list) {
        if (client.url.includes('dashboard.php') && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
