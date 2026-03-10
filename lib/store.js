// ═══════════════════════════════════════════════════════
//  TOKEN STORE — SQLite (better-sqlite3)
// ═══════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tokens.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        subdomain TEXT PRIMARY KEY,
        auth_mode TEXT NOT NULL CHECK(auth_mode IN ('oauth','long_lived')),
        access_token TEXT,
        refresh_token TEXT,
        long_lived_token TEXT,
        expires_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS business_hours (
        subdomain TEXT PRIMARY KEY,
        work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
        start_time TEXT NOT NULL DEFAULT '08:00',
        end_time TEXT NOT NULL DEFAULT '18:00',
        sla_target_minutes INTEGER NOT NULL DEFAULT 30,
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      )
    `);
  }
  return db;
}

function upsertOAuth(subdomain, { access_token, refresh_token, expires_in }) {
  const expires_at = Math.floor(Date.now() / 1000) + expires_in;
  getDb().prepare(`
    INSERT INTO accounts (subdomain, auth_mode, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, 'oauth', ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(subdomain) DO UPDATE SET
      auth_mode='oauth',
      access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,
      expires_at=excluded.expires_at,
      updated_at=strftime('%s','now')
  `).run(subdomain, access_token, refresh_token, expires_at);
}

function upsertLongLived(subdomain, { token, expires_at }) {
  getDb().prepare(`
    INSERT INTO accounts (subdomain, auth_mode, long_lived_token, expires_at, updated_at)
    VALUES (?, 'long_lived', ?, ?, strftime('%s','now'))
    ON CONFLICT(subdomain) DO UPDATE SET
      auth_mode='long_lived',
      long_lived_token=excluded.long_lived_token,
      expires_at=excluded.expires_at,
      updated_at=strftime('%s','now')
  `).run(subdomain, token, expires_at || null);
}

function getAccount(subdomain) {
  return getDb().prepare('SELECT * FROM accounts WHERE subdomain = ?').get(subdomain);
}

function listAccounts() {
  return getDb().prepare('SELECT subdomain, auth_mode, expires_at FROM accounts ORDER BY updated_at DESC').all();
}

function removeAccount(subdomain) {
  getDb().prepare('DELETE FROM accounts WHERE subdomain = ?').run(subdomain);
}

// ─── Business Hours ──────────────────────────────────

function getBusinessHours(subdomain) {
  const row = getDb().prepare('SELECT * FROM business_hours WHERE subdomain = ?').get(subdomain);
  if (row) return row;
  // Return defaults
  return { subdomain, work_days: '1,2,3,4,5', start_time: '08:00', end_time: '18:00', sla_target_minutes: 30 };
}

function upsertBusinessHours(subdomain, { work_days, start_time, end_time, sla_target_minutes }) {
  getDb().prepare(`
    INSERT INTO business_hours (subdomain, work_days, start_time, end_time, sla_target_minutes, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(subdomain) DO UPDATE SET
      work_days=excluded.work_days,
      start_time=excluded.start_time,
      end_time=excluded.end_time,
      sla_target_minutes=excluded.sla_target_minutes,
      updated_at=strftime('%s','now')
  `).run(subdomain, work_days, start_time, end_time, sla_target_minutes);
}

module.exports = {
  getDb, upsertOAuth, upsertLongLived, getAccount, listAccounts, removeAccount,
  getBusinessHours, upsertBusinessHours,
};
