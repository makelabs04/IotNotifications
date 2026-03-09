/**
 * server.js — IoT Push Notification Server
 * Runs alongside your PHP dashboard, uses the same MySQL database.
 * Deploy on Hostinger Node.js hosting.
 */
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const poller     = require('./poller');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ── CORS ──────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. mobile, Postman) and whitelisted origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  },
  methods:     ['GET', 'POST', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────
app.use('/api/subscribe', require('./routes/subscribe'));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'iot-push-notifier',
    time:    new Date().toISOString(),
  });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] IoT Push Notifier running on port ${PORT}`);
  poller.start();
});
