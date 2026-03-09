/**
 * db.js — MySQL connection pool (shared DB with PHP dashboard)
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || '127.0.0.1',
  port:     parseInt(process.env.DB_PORT      || '3306'),
  database:           process.env.DB_NAME     || 'u966260443_relaycontrol',
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone:           '+00:00',
});

pool.getConnection()
  .then(conn => { console.log('[DB] Connected to MySQL'); conn.release(); })
  .catch(err => { console.error('[DB] Connection failed:', err.message); process.exit(1); });

module.exports = pool;
