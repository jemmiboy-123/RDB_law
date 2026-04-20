'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const {
  db, now, today, logActivity,
  getUserById, getUserByEmail,
  getCaseLawyers, setCaseLawyers,
  getClientProfile, getInvoicePayments,
} = require('../db');
const { sendEmailIfConfigured } = require('../email');
const { requireAuth, requireRole } = require('../middleware/auth');

// ─── File upload ────────────────────────────────────────────────────────────
const ALLOWED_EXT = new Set(['pdf', 'doc', 'docx', 'txt', 'jpg', 'jpeg', 'png']);
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', '..', 'app', 'uploads'),
    filename: (req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${uuidv4().replace(/-/g, '')}_${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    cb(null, ALLOWED_EXT.has(ext));
  },
});

// ─── Helpers ────────────────────────────────────────────────────────────────
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });

function userJson(u) {
  return { id: u.id, full_name: u.full_name, email: u.email, role: u.role, is_active_user: !!u.is_active_user };
}

function clientJson(c) {
  return { id: c.id, full_name: c.full_name, email: c.email, phone: c.phone, address: c.address, company: c.company, notes: c.notes, portal_user_id: c.portal_user_id };
}

function caseJson(c) {
  const lawyers = getCaseLawyers(c.id);
  const client = db.prepare('SELECT id, full_name FROM client WHERE id = ?').get(c.client_id);
  return {
    id: c.id, title: c.title, reference_number: c.reference_number,
    case_type: c.case_type, description: c.description, status: c.status,
    opened_on: c.opened_on, closed_on: c.closed_on, updated_at: c.updated_at,
    client: client || { id: c.client_id, full_name: '' },
    lawyers: lawyers.map(l => ({ id: l.id, full_name: l.full_name })),
  };
}

function taskJson(t) {
  const caseRow = db.prepare('SELECT id, reference_number FROM "case" WHERE id = ?').get(t.case_id);
  const assignee = db.prepare('SELECT id, full_name FROM "user" WHERE id = ?').get(t.assignee_id);
  return {
    id: t.id,
    case: caseRow || { id: t.case_id, reference_number: '' },
    title: t.title, details: t.details,
    assignee: assignee || { id: t.assignee_id, full_name: '' },
    due_date: t.due_date, status: t.status,
  };
}

function canViewCase(user, c) {
  if (['admin', 'lawyer', 'staff'].includes(user.role)) return true;
  if (user.role === 'client') {
    const profile = getClientProfile(user.id);
    return !!(profile && c.client_id === profile.id);
  }
  return false;
}

// ─── Public routes (no auth) ─────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  const { email = '', password = '' } = req.body;
  const user = getUserByEmail(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return err(res, 'Invalid credentials', 401);
  }
  req.session.user = userJson(user);
  return res.json({ user: userJson(user) });
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  if (!req.session.user) return err(res, 'Authentication required', 401);
  return res.json({ user: req.session.user });
});

// ─── Require auth for everything below ──────────────────────────────────
router.use(requireAuth);

// ─── Dashboard ────────────────────────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;

  let casesQ = 'SELECT c.*, cl.full_name AS client_name FROM "case" c JOIN client cl ON c.client_id = cl.id WHERE c.status != ?';
  const caseArgs = ['closed'];
  if (profile) { casesQ += ' AND c.client_id = ?'; caseArgs.push(profile.id); }
  casesQ += ' ORDER BY c.updated_at DESC LIMIT 8';
  const activeCases = db.prepare(casesQ).all(...caseArgs).map(c => caseJson(c));

  let dlQ = `SELECT d.*, c.reference_number AS case_ref, c.id AS case_id FROM deadline d JOIN "case" c ON d.case_id = c.id WHERE d.due_date >= ?`;
  const dlArgs = [now()];
  if (profile) { dlQ += ' AND c.client_id = ?'; dlArgs.push(profile.id); }
  dlQ += ' ORDER BY d.due_date ASC LIMIT 8';
  const upcomingDeadlines = db.prepare(dlQ).all(...dlArgs);

  const recentActivities = db.prepare(`
    SELECT a.*, u.full_name AS user_name FROM activity_log a
    LEFT JOIN "user" u ON a.user_id = u.id
    ORDER BY a.created_at DESC LIMIT 12
  `).all();

  let taskQ = `SELECT t.* FROM task t JOIN "case" c ON t.case_id = c.id WHERE t.status != 'done'`;
  const taskArgs = [];
  if (profile) { taskQ += ' AND c.client_id = ?'; taskArgs.push(profile.id); }
  else if (['lawyer', 'staff'].includes(user.role)) { taskQ += ' AND t.assignee_id = ?'; taskArgs.push(user.id); }

  let invQ = 'SELECT i.* FROM invoice i JOIN client cl ON i.client_id = cl.id WHERE i.status IN (?, ?)';
  const invArgs = ['sent', 'partial'];
  if (user.role === 'client' && profile) { invQ += ' AND i.client_id = ?'; invArgs.push(profile.id); }

  res.json({
    stats: {
      active_cases: db.prepare(casesQ.replace('ORDER BY c.updated_at DESC LIMIT 8', '')).all(...caseArgs).length,
      upcoming_deadlines: db.prepare(dlQ.replace('ORDER BY d.due_date ASC LIMIT 8', '')).all(...dlArgs).length,
      open_tasks: db.prepare(taskQ).all(...taskArgs).length,
      unpaid_invoices: db.prepare(invQ).all(...invArgs).length,
    },
    active_cases: activeCases,
    upcoming_deadlines: upcomingDeadlines.map(d => ({
      id: d.id, title: d.title, due_date: d.due_date, kind: d.kind,
      case: { id: d.case_id, reference_number: d.case_ref },
    })),
    recent_activities: recentActivities.map(a => ({
      id: a.id, action: a.action, target: a.target,
      created_at: a.created_at, user: a.user_name || 'System',
    })),
  });
});

// ─── Meta ─────────────────────────────────────────────────────────────────
router.get('/meta', (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;

  let cases = db.prepare('SELECT id, reference_number, title FROM "case" ORDER BY reference_number ASC').all();
  let clients = db.prepare('SELECT id, full_name FROM client ORDER BY full_name ASC').all();
  let users = db.prepare(`SELECT id, full_name, role FROM "user" ORDER BY full_name ASC`).all();

  if (profile) {
    cases = cases.filter(c => {
      const row = db.prepare('SELECT client_id FROM "case" WHERE id = ?').get(c.id);
      return row && row.client_id === profile.id;
    });
    clients = clients.filter(cl => cl.id === profile.id);
    users = users.filter(u => u.id === user.id);
  }

  res.json({ cases, clients, users });
});

// ─── Clients ─────────────────────────────────────────────────────────────
router.get('/clients', (req, res) => {
  const user = req.session.user;
  if (user.role === 'client') {
    const profile = getClientProfile(user.id);
    return res.json({ items: profile ? [clientJson(profile)] : [] });
  }
  const q = (req.query.q || '').trim();
  let clients = db.prepare(
    q ? 'SELECT * FROM client WHERE full_name LIKE ? ORDER BY full_name ASC'
      : 'SELECT * FROM client ORDER BY full_name ASC'
  ).all(q ? `%${q}%` : undefined);
  res.json({ items: clients.map(clientJson) });
});

router.post('/clients', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  const full_name = (b.full_name || '').trim();
  if (!full_name) return err(res, 'full_name is required');
  const info = db.prepare(`
    INSERT INTO client (full_name, email, phone, address, company, notes, portal_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(full_name, (b.email||'').trim(), (b.phone||'').trim(), (b.address||'').trim(), (b.company||'').trim(), (b.notes||'').trim(), b.portal_user_id || null);
  const client = db.prepare('SELECT * FROM client WHERE id = ?').get(info.lastInsertRowid);
  logActivity(req.session.user.id, `Created client ${full_name}`, `client:${full_name}`);
  res.status(201).json({ item: clientJson(client) });
});

router.get('/clients/:id', (req, res) => {
  const user = req.session.user;
  const client = db.prepare('SELECT * FROM client WHERE id = ?').get(req.params.id);
  if (!client) return err(res, 'Client not found', 404);
  if (user.role === 'client' && client.portal_user_id !== user.id) return err(res, 'Forbidden', 403);
  const cases = db.prepare('SELECT * FROM "case" WHERE client_id = ? ORDER BY created_at DESC').all(client.id);
  res.json({ item: clientJson(client), case_history: cases.map(caseJson) });
});

router.put('/clients/:id', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const client = db.prepare('SELECT * FROM client WHERE id = ?').get(req.params.id);
  if (!client) return err(res, 'Client not found', 404);
  const b = req.body;
  const fields = ['full_name', 'email', 'phone', 'address', 'company', 'notes'];
  for (const f of fields) if (f in b) client[f] = (b[f] || '').trim();
  if ('portal_user_id' in b) client.portal_user_id = b.portal_user_id || null;
  db.prepare(`UPDATE client SET full_name=?,email=?,phone=?,address=?,company=?,notes=?,portal_user_id=?,updated_at=? WHERE id=?`)
    .run(client.full_name, client.email, client.phone, client.address, client.company, client.notes, client.portal_user_id, now(), client.id);
  logActivity(req.session.user.id, `Updated client ${client.full_name}`, `client:${client.id}`);
  res.json({ item: clientJson(db.prepare('SELECT * FROM client WHERE id = ?').get(client.id)) });
});

// ─── Cases ────────────────────────────────────────────────────────────────
router.get('/cases', (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const status = req.query.status || '';
  const q = (req.query.q || '').trim();

  let sql = 'SELECT c.* FROM "case" c JOIN client cl ON c.client_id = cl.id WHERE 1=1';
  const args = [];
  if (profile) { sql += ' AND c.client_id = ?'; args.push(profile.id); }
  if (status) { sql += ' AND c.status = ?'; args.push(status); }
  if (q) { sql += ' AND c.title LIKE ?'; args.push(`%${q}%`); }
  sql += ' ORDER BY c.updated_at DESC';

  res.json({ items: db.prepare(sql).all(...args).map(caseJson) });
});

router.post('/cases', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  const title = (b.title || '').trim();
  const ref = (b.reference_number || '').trim();
  if (!title || !ref || !b.client_id) return err(res, 'title, reference_number, client_id are required');
  const info = db.prepare(`
    INSERT INTO "case" (title, reference_number, case_type, description, status, opened_on, client_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, ref, (b.case_type||'').trim(), (b.description||'').trim(), b.status||'open', b.opened_on||today(), b.client_id);
  setCaseLawyers(info.lastInsertRowid, b.lawyer_ids || []);
  logActivity(req.session.user.id, `Created case ${ref}`, `case:${ref}`);
  const c = db.prepare('SELECT * FROM "case" WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item: caseJson(c) });
});

router.get('/cases/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM "case" WHERE id = ?').get(req.params.id);
  if (!c) return err(res, 'Case not found', 404);
  if (!canViewCase(req.session.user, c)) return err(res, 'Forbidden', 403);

  const notes = db.prepare(`
    SELECT cn.*, u.full_name AS author_name FROM case_note cn
    JOIN "user" u ON cn.author_id = u.id
    WHERE cn.case_id = ? ORDER BY cn.created_at DESC
  `).all(c.id);
  const docs = db.prepare('SELECT * FROM document WHERE case_id = ? ORDER BY created_at DESC LIMIT 10').all(c.id);
  const tasks = db.prepare('SELECT * FROM task WHERE case_id = ? ORDER BY created_at DESC LIMIT 10').all(c.id);

  res.json({
    item: caseJson(c),
    notes: notes.map(n => ({ id: n.id, body: n.body, author: n.author_name, created_at: n.created_at })),
    documents: docs.map(d => ({ id: d.id, original_name: d.original_name, category: d.category, created_at: d.created_at })),
    tasks: tasks.map(taskJson),
  });
});

router.put('/cases/:id', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const c = db.prepare('SELECT * FROM "case" WHERE id = ?').get(req.params.id);
  if (!c) return err(res, 'Case not found', 404);
  const b = req.body;
  const updated = {
    title: 'title' in b ? (b.title||'').trim() : c.title,
    reference_number: 'reference_number' in b ? (b.reference_number||'').trim() : c.reference_number,
    case_type: 'case_type' in b ? (b.case_type||'').trim() : c.case_type,
    description: 'description' in b ? (b.description||'').trim() : c.description,
    status: 'status' in b ? (b.status||'open') : c.status,
    opened_on: 'opened_on' in b ? (b.opened_on||c.opened_on) : c.opened_on,
    closed_on: 'closed_on' in b ? (b.closed_on||null) : c.closed_on,
    client_id: 'client_id' in b ? b.client_id : c.client_id,
  };
  db.prepare(`UPDATE "case" SET title=?,reference_number=?,case_type=?,description=?,status=?,opened_on=?,closed_on=?,client_id=?,updated_at=? WHERE id=?`)
    .run(updated.title, updated.reference_number, updated.case_type, updated.description, updated.status, updated.opened_on, updated.closed_on, updated.client_id, now(), c.id);
  if ('lawyer_ids' in b) setCaseLawyers(c.id, b.lawyer_ids || []);
  logActivity(req.session.user.id, `Updated case ${updated.reference_number}`, `case:${c.id}`);
  res.json({ item: caseJson(db.prepare('SELECT * FROM "case" WHERE id = ?').get(c.id)) });
});

router.post('/cases/:id/notes', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const c = db.prepare('SELECT * FROM "case" WHERE id = ?').get(req.params.id);
  if (!c) return err(res, 'Case not found', 404);
  const body = (req.body.body || '').trim();
  if (!body) return err(res, 'body is required');
  const info = db.prepare('INSERT INTO case_note (case_id, author_id, body) VALUES (?, ?, ?)').run(c.id, req.session.user.id, body);
  const note = db.prepare('SELECT * FROM case_note WHERE id = ?').get(info.lastInsertRowid);
  logActivity(req.session.user.id, `Added note to ${c.reference_number}`, `case:${c.id}`);
  res.status(201).json({ item: { id: note.id, body: note.body, author: req.session.user.full_name, created_at: note.created_at } });
});

// ─── Documents ────────────────────────────────────────────────────────────
router.get('/documents', (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const q = (req.query.q || '').trim();
  const caseId = req.query.case_id ? parseInt(req.query.case_id) : null;

  let sql = 'SELECT d.* FROM document d JOIN "case" c ON d.case_id = c.id WHERE 1=1';
  const args = [];
  if (profile) { sql += ' AND c.client_id = ?'; args.push(profile.id); }
  if (q) { sql += ' AND d.original_name LIKE ?'; args.push(`%${q}%`); }
  if (caseId) { sql += ' AND d.case_id = ?'; args.push(caseId); }
  sql += ' ORDER BY d.created_at DESC';

  const docs = db.prepare(sql).all(...args).map(d => {
    const caseRow = db.prepare('SELECT id, reference_number FROM "case" WHERE id = ?').get(d.case_id);
    return { id: d.id, original_name: d.original_name, category: d.category, description: d.description, created_at: d.created_at, case: caseRow || { id: d.case_id, reference_number: '' } };
  });
  res.json({ items: docs });
});

router.post('/documents', requireRole('admin', 'lawyer', 'staff'), upload.single('file'), (req, res) => {
  const caseId = parseInt(req.body.case_id);
  const caseRow = db.prepare('SELECT * FROM "case" WHERE id = ?').get(caseId);
  if (!caseRow) return err(res, 'Valid case_id is required');
  if (!req.file) return err(res, 'Unsupported or missing file');
  const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
  const info = db.prepare(`
    INSERT INTO document (case_id, uploaded_by_id, filename, original_name, category, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(caseRow.id, req.session.user.id, req.file.filename, safeName, (req.body.category||'General').trim(), (req.body.description||'').trim());
  logActivity(req.session.user.id, `Uploaded document for ${caseRow.reference_number}`, `document:${safeName}`);
  res.status(201).json({ item: { id: info.lastInsertRowid, original_name: safeName } });
});

router.get('/documents/:id/download', (req, res) => {
  const doc = db.prepare('SELECT * FROM document WHERE id = ?').get(req.params.id);
  if (!doc) return err(res, 'Document not found', 404);
  const caseRow = db.prepare('SELECT * FROM "case" WHERE id = ?').get(doc.case_id);
  if (!canViewCase(req.session.user, caseRow)) return err(res, 'Forbidden', 403);
  const filePath = path.join(__dirname, '..', '..', 'app', 'uploads', doc.filename);
  res.download(filePath, doc.original_name);
});

// ─── Calendar / Deadlines ─────────────────────────────────────────────────
router.get('/calendar', (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;

  let sql = `SELECT d.*, c.reference_number AS case_ref, c.id AS case_id2 FROM deadline d JOIN "case" c ON d.case_id = c.id WHERE d.due_date >= ?`;
  const args = [now().slice(0, 10) + ' 00:00:00'];
  if (profile) { sql += ' AND c.client_id = ?'; args.push(profile.id); }
  sql += ' ORDER BY d.due_date ASC';

  res.json({
    items: db.prepare(sql).all(...args).map(d => ({
      id: d.id, title: d.title, due_date: d.due_date, kind: d.kind,
      case: { id: d.case_id, reference_number: d.case_ref },
    })),
  });
});

router.post('/calendar', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  if (!b.case_id || !b.title || !b.due_date) return err(res, 'case_id, title, due_date are required');
  const caseRow = db.prepare('SELECT * FROM "case" WHERE id = ?').get(b.case_id);
  if (!caseRow) return err(res, 'Case not found', 404);
  const info = db.prepare('INSERT INTO deadline (case_id, title, due_date, kind) VALUES (?, ?, ?, ?)').run(b.case_id, (b.title||'').trim(), b.due_date, (b.kind||'deadline').trim());
  const lawyers = getCaseLawyers(b.case_id);
  for (const l of lawyers) {
    if (l.email) sendEmailIfConfigured(l.email, `New ${b.kind} for ${caseRow.reference_number}`, `${b.title} is scheduled on ${b.due_date}.`);
  }
  logActivity(req.session.user.id, `Added ${b.kind} for ${caseRow.reference_number}`, `deadline:${info.lastInsertRowid}`);
  res.status(201).json({ item: { id: info.lastInsertRowid } });
});

// ─── Tasks ────────────────────────────────────────────────────────────────
router.get('/tasks', (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const mine = req.query.mine === '1';

  let sql = `SELECT t.* FROM task t JOIN "case" c ON t.case_id = c.id WHERE 1=1`;
  const args = [];
  if (profile) { sql += ' AND c.client_id = ?'; args.push(profile.id); }
  else if (mine || ['lawyer', 'staff'].includes(user.role)) { sql += ' AND t.assignee_id = ?'; args.push(user.id); }
  sql += ' ORDER BY t.created_at DESC';

  res.json({ items: db.prepare(sql).all(...args).map(taskJson) });
});

router.post('/tasks', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  if (!b.case_id || !b.title || !b.assignee_id) return err(res, 'case_id, title, assignee_id are required');
  const info = db.prepare(`
    INSERT INTO task (case_id, title, details, assignee_id, due_date, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(b.case_id, (b.title||'').trim(), (b.details||'').trim(), b.assignee_id, b.due_date||null, (b.status||'todo').trim());
  const assignee = db.prepare('SELECT * FROM "user" WHERE id = ?').get(b.assignee_id);
  if (assignee?.email) sendEmailIfConfigured(assignee.email, `Task assigned: ${b.title}`, `You have been assigned task '${b.title}'.`);
  logActivity(req.session.user.id, `Created task ${b.title}`, `task:${info.lastInsertRowid}`);
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item: taskJson(task) });
});

router.put('/tasks/:id/status', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(req.params.id);
  if (!task) return err(res, 'Task not found', 404);
  const user = req.session.user;
  if (['lawyer', 'staff'].includes(user.role) && task.assignee_id !== user.id) return err(res, 'Forbidden', 403);
  const status = req.body.status || 'todo';
  db.prepare('UPDATE task SET status=?, updated_at=? WHERE id=?').run(status, now(), task.id);
  logActivity(user.id, `Updated task status to ${status}`, `task:${task.id}`);
  res.json({ item: taskJson(db.prepare('SELECT * FROM task WHERE id = ?').get(task.id)) });
});

// ─── Billing ─────────────────────────────────────────────────────────────
router.get('/billing', (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;

  let entrySql = `SELECT e.* FROM time_entry e JOIN "case" c ON e.case_id = c.id JOIN client cl ON c.client_id = cl.id WHERE 1=1`;
  let invSql = 'SELECT i.* FROM invoice i JOIN client cl ON i.client_id = cl.id WHERE 1=1';
  const entryArgs = [], invArgs = [];
  if (profile) {
    entrySql += ' AND c.client_id = ?'; entryArgs.push(profile.id);
    invSql += ' AND i.client_id = ?'; invArgs.push(profile.id);
  }
  entrySql += ' ORDER BY e.entry_date DESC LIMIT 50';
  invSql += ' ORDER BY i.created_at DESC LIMIT 25';

  const entries = db.prepare(entrySql).all(...entryArgs).map(e => {
    const caseRow = db.prepare('SELECT id, reference_number FROM "case" WHERE id = ?').get(e.case_id);
    const lawyer = db.prepare('SELECT id, full_name FROM "user" WHERE id = ?').get(e.lawyer_id);
    return { id: e.id, entry_date: e.entry_date, hours: e.hours, rate: e.rate, description: e.description, billed: !!e.billed, case: caseRow, lawyer };
  });
  const invoices = db.prepare(invSql).all(...invArgs).map(i => {
    const client = db.prepare('SELECT id, full_name FROM client WHERE id = ?').get(i.client_id);
    return { id: i.id, invoice_number: i.invoice_number, status: i.status, total: i.total, client };
  });

  res.json({ entries, invoices });
});

router.post('/billing/time-entries', requireRole('admin', 'lawyer'), (req, res) => {
  const b = req.body;
  if (!b.case_id || !b.lawyer_id || !b.description) return err(res, 'case_id, lawyer_id, description are required');
  const info = db.prepare(`
    INSERT INTO time_entry (case_id, lawyer_id, entry_date, hours, rate, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(b.case_id, b.lawyer_id, b.entry_date||today(), parseFloat(b.hours||0), parseFloat(b.rate||0), (b.description||'').trim());
  logActivity(req.session.user.id, `Added billable entry (${b.hours}h)`, `case:${b.case_id}`);
  res.status(201).json({ item: { id: info.lastInsertRowid } });
});

router.post('/billing/invoices', requireRole('admin', 'lawyer'), (req, res) => {
  const b = req.body;
  const clientId = b.client_id;
  const taxRate = parseFloat(b.tax_rate || 0);
  const dueDate = b.due_date || today();

  const entries = db.prepare(`
    SELECT e.* FROM time_entry e JOIN "case" c ON e.case_id = c.id
    WHERE c.client_id = ? AND e.billed = 0 ORDER BY e.entry_date ASC
  `).all(clientId);
  if (!entries.length) return err(res, 'No unbilled entries for this client');

  const invNum = `INV-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  const invInfo = db.prepare(`
    INSERT INTO invoice (invoice_number, client_id, issue_date, due_date, status) VALUES (?, ?, ?, ?, 'sent')
  `).run(invNum, clientId, today(), dueDate);
  const invoiceId = invInfo.lastInsertRowid;

  let subtotal = 0;
  for (const e of entries) {
    const amount = e.hours * e.rate;
    subtotal += amount;
    db.prepare('INSERT INTO invoice_item (invoice_id, time_entry_id, description, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)')
      .run(invoiceId, e.id, `${e.entry_date} - ${e.description}`, e.hours, e.rate, amount);
    db.prepare('UPDATE time_entry SET billed=1 WHERE id=?').run(e.id);
  }
  const tax = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  db.prepare('UPDATE invoice SET subtotal=?, tax=?, total=? WHERE id=?').run(Math.round(subtotal * 100) / 100, tax, total, invoiceId);
  logActivity(req.session.user.id, `Generated invoice ${invNum}`, `invoice:${invoiceId}`);
  res.status(201).json({ item: { id: invoiceId, invoice_number: invNum } });
});

router.post('/billing/invoices/:id/payments', requireRole('admin', 'lawyer', 'staff'), (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoice WHERE id = ?').get(req.params.id);
  if (!invoice) return err(res, 'Invoice not found', 404);
  const b = req.body;
  const info = db.prepare('INSERT INTO payment (invoice_id, amount, payment_date, method, reference) VALUES (?, ?, ?, ?, ?)')
    .run(invoice.id, parseFloat(b.amount||0), b.payment_date||today(), (b.method||'bank_transfer').trim(), (b.reference||'').trim());
  const payments = getInvoicePayments(invoice.id);
  const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
  const newStatus = paidTotal >= invoice.total ? 'paid' : (paidTotal > 0 ? 'partial' : invoice.status);
  db.prepare('UPDATE invoice SET status=?, updated_at=? WHERE id=?').run(newStatus, now(), invoice.id);
  logActivity(req.session.user.id, `Recorded payment for ${invoice.invoice_number}`, `invoice:${invoice.id}`);
  res.status(201).json({ item: { id: info.lastInsertRowid } });
});

// ─── Users ────────────────────────────────────────────────────────────────
router.get('/users', requireRole('admin'), (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM "user" ORDER BY created_at DESC').all().map(userJson) });
});

router.post('/users', requireRole('admin'), (req, res) => {
  const b = req.body;
  const full_name = (b.full_name || '').trim();
  const email = (b.email || '').trim().toLowerCase();
  if (!full_name || !email) return err(res, 'full_name and email are required');
  const hash = bcrypt.hashSync(b.password || 'TempPass123!', 10);
  const info = db.prepare(`INSERT INTO "user" (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(full_name, email, hash, (b.role||'staff').trim());
  logActivity(req.session.user.id, `Created user ${email}`, `user:${email}`);
  res.status(201).json({ item: userJson(db.prepare('SELECT * FROM "user" WHERE id = ?').get(info.lastInsertRowid)) });
});

// ─── Notifications ────────────────────────────────────────────────────────
router.get('/notifications', (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  let remSql = `SELECT d.*, c.reference_number AS case_ref, c.id AS case_id2 FROM deadline d JOIN "case" c ON d.case_id = c.id WHERE d.due_date <= ?`;
  const remArgs = [soon];
  if (profile) { remSql += ' AND c.client_id = ?'; remArgs.push(profile.id); }
  remSql += ' ORDER BY d.due_date ASC';

  let taskSql = `SELECT t.* FROM task t JOIN "case" c ON t.case_id = c.id WHERE t.status != 'done' AND t.due_date < ?`;
  const taskArgs = [today()];
  if (profile) { taskSql += ' AND c.client_id = ?'; taskArgs.push(profile.id); }
  else if (['lawyer', 'staff'].includes(user.role)) { taskSql += ' AND t.assignee_id = ?'; taskArgs.push(user.id); }
  taskSql += ' ORDER BY t.due_date ASC';

  res.json({
    reminders: db.prepare(remSql).all(...remArgs).map(d => ({
      id: d.id, title: d.title, due_date: d.due_date,
      case: { id: d.case_id, reference_number: d.case_ref },
    })),
    overdue_tasks: db.prepare(taskSql).all(...taskArgs).map(taskJson),
  });
});

module.exports = router;
