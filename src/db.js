'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/^sqlite:\/{2,3}/, '')
  : path.join(__dirname, '..', 'lawfirm.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ─── Schema ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS "user" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    is_active_user INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS client (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    address TEXT,
    company TEXT,
    notes TEXT,
    portal_user_id INTEGER UNIQUE REFERENCES "user"(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS "case" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    reference_number TEXT UNIQUE NOT NULL,
    case_type TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    opened_on TEXT NOT NULL,
    closed_on TEXT,
    client_id INTEGER NOT NULL REFERENCES client(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS case_lawyers (
    case_id INTEGER NOT NULL REFERENCES "case"(id),
    user_id INTEGER NOT NULL REFERENCES "user"(id),
    PRIMARY KEY (case_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS case_note (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES "case"(id),
    author_id INTEGER NOT NULL REFERENCES "user"(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS document (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES "case"(id),
    uploaded_by_id INTEGER NOT NULL REFERENCES "user"(id),
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deadline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES "case"(id),
    title TEXT NOT NULL,
    due_date TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'deadline',
    reminder_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES "case"(id),
    title TEXT NOT NULL,
    details TEXT,
    assignee_id INTEGER NOT NULL REFERENCES "user"(id),
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS time_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES "case"(id),
    lawyer_id INTEGER NOT NULL REFERENCES "user"(id),
    entry_date TEXT NOT NULL,
    hours REAL NOT NULL,
    rate REAL NOT NULL,
    description TEXT NOT NULL,
    billed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE NOT NULL,
    client_id INTEGER NOT NULL REFERENCES client(id),
    issue_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    subtotal REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoice_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoice(id),
    time_entry_id INTEGER REFERENCES time_entry(id),
    description TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoice(id),
    amount REAL NOT NULL,
    payment_date TEXT NOT NULL,
    method TEXT NOT NULL,
    reference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES "user"(id),
    action TEXT NOT NULL,
    target TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── Seed ──────────────────────────────────────────────────────────────────
function seedAdmin() {
  const exists = db.prepare('SELECT id FROM "user" WHERE email = ?').get('admin@lawfirm.local');
  if (!exists) {
    const hash = bcrypt.hashSync('admin12345', 10);
    db.prepare(
      'INSERT INTO "user" (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run('System Administrator', 'admin@lawfirm.local', hash, 'admin');
    console.log('Admin user seeded: admin@lawfirm.local / admin12345');
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────
function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Query helpers ────────────────────────────────────────────────────────
function logActivity(userId, action, target = '') {
  db.prepare('INSERT INTO activity_log (user_id, action, target) VALUES (?, ?, ?)')
    .run(userId || null, action, target);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM "user" WHERE id = ?').get(id);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM "user" WHERE email = ? AND is_active_user = 1').get(email);
}

function getCaseLawyers(caseId) {
  return db.prepare(`
    SELECT u.* FROM "user" u
    JOIN case_lawyers cl ON u.id = cl.user_id
    WHERE cl.case_id = ?
  `).all(caseId);
}

function setCaseLawyers(caseId, lawyerIds) {
  db.prepare('DELETE FROM case_lawyers WHERE case_id = ?').run(caseId);
  const ins = db.prepare('INSERT OR IGNORE INTO case_lawyers (case_id, user_id) VALUES (?, ?)');
  for (const id of (lawyerIds || [])) ins.run(caseId, id);
}

function getClientProfile(userId) {
  return db.prepare('SELECT * FROM client WHERE portal_user_id = ?').get(userId);
}

function getInvoicePayments(invoiceId) {
  return db.prepare('SELECT * FROM payment WHERE invoice_id = ?').all(invoiceId);
}

module.exports = {
  db,
  seedAdmin,
  now,
  today,
  logActivity,
  getUserById,
  getUserByEmail,
  getCaseLawyers,
  setCaseLawyers,
  getClientProfile,
  getInvoicePayments,
};
