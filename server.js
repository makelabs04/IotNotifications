/**
 * server.js — IoT Push Notification Server
 * Serves both industrycontrol & relaycontrol dashboards.
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const poller  = require('./poller');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ── CORS ───────────────────────────────────────────────────────────
// Strip trailing slashes — browsers send origins WITHOUT them.
// e.g. "https://example.com/" in .env must match "https://example.com"
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))   // <── removes trailing slash
  .filter(Boolean);

console.log('[server] Allowed origins:', allowedOrigins);

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin requests (Postman, mobile, server-to-server)
    if (!origin) return cb(null, true);
    // Normalise the incoming origin too (just in case)
    const normOrigin = origin.replace(/\/+$/, '');
    if (allowedOrigins.includes(normOrigin)) return cb(null, true);
    console.warn('[CORS] Blocked origin:', origin);
    cb(new Error('CORS blocked: ' + origin));
  },
  methods:     ['GET', 'POST', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ─────────────────────────────────────────────────────────
app.use('/api/subscribe', require('./routes/subscribe'));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status:          'ok',
    service:         'iot-push-notifier',
    allowed_origins: allowedOrigins,
    time:            new Date().toISOString(),
  });
});

// ── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] IoT Push Notifier running on port ${PORT}`);
  poller.start();
});
