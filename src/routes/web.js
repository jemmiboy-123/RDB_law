'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const {
  db, now, today, logActivity,
  getCaseLawyers, setCaseLawyers,
  getClientProfile,
} = require('../db');
const { sendEmailIfConfigured } = require('../email');
const { requireLogin, requireWebRole } = require('../middleware/auth');

// File upload (for documents)
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

// ─── Helpers ─────────────────────────────────────────────────────────────
function flash(req, type, msg) {
  if (!req.session.flash) req.session.flash = [];
  req.session.flash.push({ type, msg });
}

function fmtDate(str) {
  if (!str) return '';
  return String(str).slice(0, 10);
}

function fmtDateTime(str) {
  if (!str) return '';
  return String(str).slice(0, 16).replace('T', ' ');
}

function canViewCase(user, c) {
  if (['admin', 'lawyer', 'staff'].includes(user.role)) return true;
  if (user.role === 'client') {
    const profile = getClientProfile(user.id);
    return !!(profile && c.client_id === profile.id);
  }
  return false;
}

function getCaseWithRelations(caseId) {
  const c = db.prepare('SELECT * FROM "case" WHERE id = ?').get(caseId);
  if (!c) return null;
  c.lawyers = getCaseLawyers(caseId);
  c.client = db.prepare('SELECT * FROM client WHERE id = ?').get(c.client_id);
  return c;
}

// Template locals helper
function tplLocals(req, extra = {}) {
  return { user: req.session.user, flash: res_flash(req), fmtDate, fmtDateTime, ...extra };
}

function res_flash(req) {
  // Flash is already in res.locals from server.js middleware
  return [];
}

// ─── Root ─────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// ─── Auth ─────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login');
});

router.post('/login', (req, res) => {
  const { email = '', password = '' } = req.body;
  const user = db.prepare('SELECT * FROM "user" WHERE email = ? AND is_active_user = 1').get(email.trim().toLowerCase());
  if (user && bcrypt.compareSync(password, user.password_hash)) {
    req.session.user = { id: user.id, full_name: user.full_name, email: user.email, role: user.role };
    return res.redirect('/dashboard');
  }
  flash(req, 'error', 'Invalid credentials.');
  res.redirect('/login');
});

router.get('/logout', requireLogin, (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ─── Dashboard ───────────────────────────────────────────────────────────
router.get('/dashboard', requireLogin, (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;

  let casesQ = `SELECT c.* FROM "case" c WHERE c.status != 'closed'`;
  const caseArgs = [];
  if (profile) { casesQ += ' AND c.client_id = ?'; caseArgs.push(profile.id); }
  casesQ += ' ORDER BY c.updated_at DESC LIMIT 8';
  const activeCases = db.prepare(casesQ).all(...caseArgs).map(c => {
    c.client = db.prepare('SELECT * FROM client WHERE id = ?').get(c.client_id);
    return c;
  });

  let dlQ = `SELECT d.*, c.reference_number AS case_ref, c.id AS case_id FROM deadline d JOIN "case" c ON d.case_id = c.id WHERE d.due_date >= ?`;
  const dlArgs = [today()];
  if (profile) { dlQ += ' AND c.client_id = ?'; dlArgs.push(profile.id); }
  dlQ += ' ORDER BY d.due_date ASC LIMIT 8';
  const upcomingDeadlines = db.prepare(dlQ).all(...dlArgs);

  const recentActivities = db.prepare(`
    SELECT a.*, u.full_name AS user_name FROM activity_log a
    LEFT JOIN "user" u ON a.user_id = u.id
    ORDER BY a.created_at DESC LIMIT 10
  `).all();

  let taskQ = `SELECT t.* FROM task t JOIN "case" c ON t.case_id = c.id WHERE t.status != 'done'`;
  const taskArgs = [];
  if (profile) { taskQ += ' AND c.client_id = ?'; taskArgs.push(profile.id); }
  else if (['lawyer', 'staff'].includes(user.role)) { taskQ += ' AND t.assignee_id = ?'; taskArgs.push(user.id); }

  let invQ = 'SELECT i.* FROM invoice i JOIN client cl ON i.client_id = cl.id WHERE i.status IN (?, ?)';
  const invArgs = ['sent', 'partial'];
  if (user.role === 'client' && profile) { invQ += ' AND i.client_id = ?'; invArgs.push(profile.id); }

  const stats = {
    active_cases: db.prepare(casesQ.replace('ORDER BY c.updated_at DESC LIMIT 8', '')).all(...caseArgs).length,
    upcoming_deadlines: db.prepare(dlQ.replace('ORDER BY d.due_date ASC LIMIT 8', '')).all(...dlArgs).length,
    open_tasks: db.prepare(taskQ).all(...taskArgs).length,
    unpaid_invoices: db.prepare(invQ).all(...invArgs).length,
  };

  res.render('dashboard/index', { stats, active_cases: activeCases, upcoming_deadlines: upcomingDeadlines, recent_activities: recentActivities, fmtDate, fmtDateTime });
});

// ─── Clients ─────────────────────────────────────────────────────────────
router.get('/clients', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const query = (req.query.q || '').trim();
  const clients = (query
    ? db.prepare('SELECT * FROM client WHERE full_name LIKE ? ORDER BY full_name ASC').all(`%${query}%`)
    : db.prepare('SELECT * FROM client ORDER BY full_name ASC').all()
  ).map(c => {
    c.case_count = db.prepare('SELECT COUNT(*) as n FROM "case" WHERE client_id = ?').get(c.id).n;
    return c;
  });
  res.render('clients/list', { clients, query });
});

router.get('/clients/new', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const clientUsers = db.prepare(`SELECT * FROM "user" WHERE role = 'client' ORDER BY full_name ASC`).all();
  res.render('clients/form', { client: null, client_users: clientUsers });
});

router.post('/clients/new', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  db.prepare('INSERT INTO client (full_name, email, phone, address, company, notes, portal_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run((b.full_name||'').trim(), (b.email||'').trim(), (b.phone||'').trim(), (b.address||'').trim(), (b.company||'').trim(), (b.notes||'').trim(), b.portal_user_id||null);
  logActivity(req.session.user.id, `Created client ${b.full_name}`, `client:${b.full_name}`);
  flash(req, 'success', 'Client created.');
  res.redirect('/clients');
});

router.get('/clients/:id/edit', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const client = db.prepare('SELECT * FROM client WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).send('Client not found');
  const clientUsers = db.prepare(`SELECT * FROM "user" WHERE role = 'client' ORDER BY full_name ASC`).all();
  res.render('clients/form', { client, client_users: clientUsers });
});

router.post('/clients/:id/edit', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE client SET full_name=?,email=?,phone=?,address=?,company=?,notes=?,portal_user_id=?,updated_at=? WHERE id=?`)
    .run((b.full_name||'').trim(), (b.email||'').trim(), (b.phone||'').trim(), (b.address||'').trim(), (b.company||'').trim(), (b.notes||'').trim(), b.portal_user_id||null, now(), req.params.id);
  logActivity(req.session.user.id, `Updated client ${b.full_name}`, `client:${req.params.id}`);
  flash(req, 'success', 'Client updated.');
  res.redirect('/clients');
});

router.get('/clients/:id', requireLogin, (req, res) => {
  const client = db.prepare('SELECT * FROM client WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).send('Client not found');
  const user = req.session.user;
  if (user.role === 'client' && client.portal_user_id !== user.id) return res.status(403).send('Forbidden');
  const clientCases = db.prepare('SELECT * FROM "case" WHERE client_id = ? ORDER BY created_at DESC').all(client.id);
  res.render('clients/view', { client, client_cases: clientCases, fmtDate });
});

// ─── Cases ────────────────────────────────────────────────────────────────
router.get('/cases', requireLogin, (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const status = req.query.status || '';
  const search = (req.query.q || '').trim();

  let sql = 'SELECT c.* FROM "case" c JOIN client cl ON c.client_id = cl.id WHERE 1=1';
  const args = [];
  if (profile) { sql += ' AND c.client_id = ?'; args.push(profile.id); }
  if (status) { sql += ' AND c.status = ?'; args.push(status); }
  if (search) { sql += ' AND c.title LIKE ?'; args.push(`%${search}%`); }
  sql += ' ORDER BY c.updated_at DESC';

  const cases = db.prepare(sql).all(...args).map(c => {
    c.client = db.prepare('SELECT * FROM client WHERE id = ?').get(c.client_id);
    c.lawyers = getCaseLawyers(c.id);
    return c;
  });
  res.render('cases/list', { cases, status, search });
});

router.get('/cases/new', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const clients = db.prepare('SELECT * FROM client ORDER BY full_name ASC').all();
  const lawyers = db.prepare(`SELECT * FROM "user" WHERE role IN ('lawyer','admin') ORDER BY full_name ASC`).all();
  res.render('cases/form', { case: null, clients, lawyers });
});

router.post('/cases/new', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO "case" (title,reference_number,case_type,description,status,opened_on,client_id) VALUES (?,?,?,?,?,?,?)`)
    .run((b.title||'').trim(), (b.reference_number||'').trim(), (b.case_type||'').trim(), (b.description||'').trim(), b.status||'open', b.opened_on||today(), b.client_id);
  const lawyerIds = Array.isArray(b.lawyers) ? b.lawyers : (b.lawyers ? [b.lawyers] : []);
  setCaseLawyers(info.lastInsertRowid, lawyerIds);
  logActivity(req.session.user.id, `Created case ${b.reference_number}`, `case:${b.reference_number}`);
  flash(req, 'success', 'Case created.');
  res.redirect(`/cases/${info.lastInsertRowid}`);
});

router.get('/cases/:id/edit', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const c = getCaseWithRelations(req.params.id);
  if (!c) return res.status(404).send('Case not found');
  const clients = db.prepare('SELECT * FROM client ORDER BY full_name ASC').all();
  const lawyers = db.prepare(`SELECT * FROM "user" WHERE role IN ('lawyer','admin') ORDER BY full_name ASC`).all();
  res.render('cases/form', { case: c, clients, lawyers, fmtDate });
});

router.post('/cases/:id/edit', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE "case" SET title=?,reference_number=?,case_type=?,description=?,status=?,opened_on=?,closed_on=?,client_id=?,updated_at=? WHERE id=?`)
    .run((b.title||'').trim(), (b.reference_number||'').trim(), (b.case_type||'').trim(), (b.description||'').trim(), b.status||'open', b.opened_on||today(), b.closed_on||null, b.client_id, now(), req.params.id);
  const lawyerIds = Array.isArray(b.lawyers) ? b.lawyers : (b.lawyers ? [b.lawyers] : []);
  setCaseLawyers(req.params.id, lawyerIds);
  logActivity(req.session.user.id, `Updated case ${b.reference_number}`, `case:${req.params.id}`);
  flash(req, 'success', 'Case updated.');
  res.redirect(`/cases/${req.params.id}`);
});

router.get('/cases/:id', requireLogin, (req, res) => {
  const c = getCaseWithRelations(req.params.id);
  if (!c) return res.status(404).send('Case not found');
  if (!canViewCase(req.session.user, c)) return res.status(403).send('Forbidden');
  const notes = db.prepare(`SELECT cn.*, u.full_name AS author_name FROM case_note cn JOIN "user" u ON cn.author_id = u.id WHERE cn.case_id = ? ORDER BY cn.created_at DESC`).all(c.id);
  const documents = db.prepare('SELECT * FROM document WHERE case_id = ? ORDER BY created_at DESC LIMIT 5').all(c.id);
  const tasks = db.prepare('SELECT t.*, u.full_name AS assignee_name FROM task t JOIN "user" u ON t.assignee_id = u.id WHERE t.case_id = ? ORDER BY t.created_at DESC LIMIT 5').all(c.id);
  res.render('cases/view', { case: c, notes, documents, tasks, fmtDate, fmtDateTime });
});

router.post('/cases/:id', requireLogin, (req, res) => {
  const user = req.session.user;
  if (!['admin', 'lawyer', 'staff'].includes(user.role)) return res.status(403).send('Forbidden');
  const c = db.prepare('SELECT * FROM "case" WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).send('Case not found');
  const body = (req.body.note || '').trim();
  if (body) {
    db.prepare('INSERT INTO case_note (case_id, author_id, body) VALUES (?, ?, ?)').run(c.id, user.id, body);
    logActivity(user.id, `Added note to ${c.reference_number}`, `case:${c.id}`);
  }
  res.redirect(`/cases/${c.id}`);
});

// ─── Documents ────────────────────────────────────────────────────────────
router.get('/documents', requireLogin, (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const query = (req.query.q || '').trim();
  const caseFilter = req.query.case_id || '';

  let sql = 'SELECT d.* FROM document d JOIN "case" c ON d.case_id = c.id WHERE 1=1';
  const args = [];
  if (profile) { sql += ' AND c.client_id = ?'; args.push(profile.id); }
  if (query) { sql += ' AND d.original_name LIKE ?'; args.push(`%${query}%`); }
  if (caseFilter) { sql += ' AND d.case_id = ?'; args.push(parseInt(caseFilter)); }
  sql += ' ORDER BY d.created_at DESC';

  const documents = db.prepare(sql).all(...args).map(d => {
    d.case = db.prepare('SELECT id, reference_number FROM "case" WHERE id = ?').get(d.case_id);
    return d;
  });

  let casesQ = 'SELECT * FROM "case"';
  const casesArgs = [];
  if (profile) { casesQ += ' WHERE client_id = ?'; casesArgs.push(profile.id); }
  casesQ += ' ORDER BY reference_number ASC';
  const cases = db.prepare(casesQ).all(...casesArgs);

  res.render('documents/list', { documents, cases, query, case_filter: caseFilter, fmtDate });
});

router.post('/documents', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), upload.single('file'), (req, res) => {
  const caseId = parseInt(req.body.case_id);
  const caseRow = db.prepare('SELECT * FROM "case" WHERE id = ?').get(caseId);
  if (!req.file || !caseRow) {
    flash(req, 'error', 'Unsupported or missing file.');
    return res.redirect('/documents');
  }
  const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
  db.prepare('INSERT INTO document (case_id, uploaded_by_id, filename, original_name, category, description) VALUES (?, ?, ?, ?, ?, ?)')
    .run(caseRow.id, req.session.user.id, req.file.filename, safeName, (req.body.category||'General').trim(), (req.body.description||'').trim());
  logActivity(req.session.user.id, `Uploaded document for ${caseRow.reference_number}`, `document:${safeName}`);
  flash(req, 'success', 'Document uploaded.');
  res.redirect('/documents');
});

router.get('/documents/:id/download', requireLogin, (req, res) => {
  const doc = db.prepare('SELECT * FROM document WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).send('Document not found');
  const caseRow = db.prepare('SELECT * FROM "case" WHERE id = ?').get(doc.case_id);
  if (!canViewCase(req.session.user, caseRow)) return res.status(403).send('Forbidden');
  res.download(path.join(__dirname, '..', '..', 'app', 'uploads', doc.filename), doc.original_name);
});

// ─── Calendar ────────────────────────────────────────────────────────────
router.get('/calendar', requireLogin, (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let dlQ = `SELECT d.*, c.reference_number AS case_ref FROM deadline d JOIN "case" c ON d.case_id = c.id WHERE d.due_date >= ?`;
  const dlArgs = [start];
  if (profile) { dlQ += ' AND c.client_id = ?'; dlArgs.push(profile.id); }
  dlQ += ' ORDER BY d.due_date ASC';
  const deadlines = db.prepare(dlQ).all(...dlArgs);

  let casesQ = 'SELECT * FROM "case"';
  const casesArgs = [];
  if (profile) { casesQ += ' WHERE client_id = ?'; casesArgs.push(profile.id); }
  casesQ += ' ORDER BY reference_number ASC';
  const cases = db.prepare(casesQ).all(...casesArgs);

  res.render('calendar/index', { deadlines, cases, fmtDate, fmtDateTime });
});

router.post('/calendar', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  const caseRow = db.prepare('SELECT * FROM "case" WHERE id = ?').get(b.case_id);
  if (!caseRow) { flash(req, 'error', 'Case not found.'); return res.redirect('/calendar'); }
  const info = db.prepare('INSERT INTO deadline (case_id, title, due_date, kind) VALUES (?, ?, ?, ?)').run(b.case_id, (b.title||'').trim(), b.due_date, (b.kind||'deadline').trim());
  const lawyers = getCaseLawyers(b.case_id);
  for (const l of lawyers) {
    if (l.email) sendEmailIfConfigured(l.email, `New ${b.kind} for ${caseRow.reference_number}`, `${b.title} is scheduled on ${b.due_date}.`);
  }
  logActivity(req.session.user.id, `Added ${b.kind} for ${caseRow.reference_number}`, `deadline:${info.lastInsertRowid}`);
  flash(req, 'success', 'Calendar event added.');
  res.redirect('/calendar');
});

// ─── Tasks ────────────────────────────────────────────────────────────────
router.get('/tasks', requireLogin, (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const myFilter = req.query.mine === '1';

  let sql = `SELECT t.*, c.reference_number AS case_ref, u.full_name AS assignee_name FROM task t JOIN "case" c ON t.case_id = c.id JOIN "user" u ON t.assignee_id = u.id WHERE 1=1`;
  const args = [];
  if (profile) { sql += ' AND c.client_id = ?'; args.push(profile.id); }
  else if (myFilter || ['lawyer', 'staff'].includes(user.role)) { sql += ' AND t.assignee_id = ?'; args.push(user.id); }
  sql += ' ORDER BY t.created_at DESC';
  const tasks = db.prepare(sql).all(...args);

  let casesQ = 'SELECT * FROM "case"';
  const casesArgs = [];
  if (profile) { casesQ += ' WHERE client_id = ?'; casesArgs.push(profile.id); }
  casesQ += ' ORDER BY reference_number ASC';
  const cases = db.prepare(casesQ).all(...casesArgs);
  const staff = db.prepare(`SELECT * FROM "user" WHERE role IN ('admin','lawyer','staff') ORDER BY full_name ASC`).all();

  res.render('tasks/index', { tasks, cases, staff, fmtDate });
});

router.post('/tasks', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const b = req.body;
  const info = db.prepare('INSERT INTO task (case_id, title, details, assignee_id, due_date, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.case_id, (b.title||'').trim(), (b.details||'').trim(), b.assignee_id, b.due_date||null, b.status||'todo');
  const assignee = db.prepare('SELECT * FROM "user" WHERE id = ?').get(b.assignee_id);
  if (assignee?.email) sendEmailIfConfigured(assignee.email, `Task assigned: ${b.title}`, `You have been assigned task '${b.title}'.`);
  logActivity(req.session.user.id, `Created task ${b.title}`, `task:${info.lastInsertRowid}`);
  flash(req, 'success', 'Task created.');
  res.redirect('/tasks');
});

router.post('/tasks/:id/status', requireLogin, (req, res) => {
  const user = req.session.user;
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).send('Task not found');
  if (!['admin', 'lawyer', 'staff'].includes(user.role)) return res.status(403).send('Forbidden');
  if (['lawyer', 'staff'].includes(user.role) && task.assignee_id !== user.id) return res.status(403).send('Forbidden');
  db.prepare('UPDATE task SET status=?, updated_at=? WHERE id=?').run(req.body.status||'todo', now(), task.id);
  logActivity(user.id, `Updated task status to ${req.body.status}`, `task:${task.id}`);
  res.redirect('/tasks');
});

// ─── Billing ─────────────────────────────────────────────────────────────
router.get('/billing', requireLogin, (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;

  let entrySql = `SELECT e.*, c.reference_number AS case_ref, u.full_name AS lawyer_name FROM time_entry e JOIN "case" c ON e.case_id = c.id JOIN "user" u ON e.lawyer_id = u.id JOIN client cl ON c.client_id = cl.id WHERE 1=1`;
  let invSql = 'SELECT i.*, cl.full_name AS client_name FROM invoice i JOIN client cl ON i.client_id = cl.id WHERE 1=1';
  const entryArgs = [], invArgs = [];
  if (profile) { entrySql += ' AND c.client_id = ?'; entryArgs.push(profile.id); invSql += ' AND i.client_id = ?'; invArgs.push(profile.id); }
  entrySql += ' ORDER BY e.entry_date DESC LIMIT 50';
  invSql += ' ORDER BY i.created_at DESC LIMIT 25';

  const entries = db.prepare(entrySql).all(...entryArgs);
  const invoices = db.prepare(invSql).all(...invArgs);

  let casesQ = 'SELECT * FROM "case"';
  const casesArgs = [];
  if (profile) { casesQ += ' WHERE client_id = ?'; casesArgs.push(profile.id); }
  casesQ += ' ORDER BY reference_number ASC';
  const cases = db.prepare(casesQ).all(...casesArgs);
  const lawyers = db.prepare(`SELECT * FROM "user" WHERE role IN ('admin','lawyer') ORDER BY full_name ASC`).all();
  let clientsQ = 'SELECT * FROM client';
  const clientsArgs = [];
  if (profile) { clientsQ += ' WHERE id = ?'; clientsArgs.push(profile.id); }
  clientsQ += ' ORDER BY full_name ASC';
  const clients = db.prepare(clientsQ).all(...clientsArgs);

  res.render('billing/index', { entries, invoices, cases, lawyers, clients, fmtDate });
});

router.post('/billing', requireLogin, requireWebRole('admin', 'lawyer'), (req, res) => {
  const b = req.body;
  db.prepare('INSERT INTO time_entry (case_id, lawyer_id, entry_date, hours, rate, description) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.case_id, b.lawyer_id, b.entry_date||today(), parseFloat(b.hours||0), parseFloat(b.rate||0), (b.description||'').trim());
  logActivity(req.session.user.id, `Added billable entry (${b.hours}h)`, `case:${b.case_id}`);
  flash(req, 'success', 'Time entry recorded.');
  res.redirect('/billing');
});

router.post('/billing/invoices/new', requireLogin, requireWebRole('admin', 'lawyer'), (req, res) => {
  const b = req.body;
  const clientId = b.client_id;
  const taxRate = parseFloat(b.tax_rate || 0);
  const dueDate = b.due_date || today();

  const entries = db.prepare(`SELECT e.* FROM time_entry e JOIN "case" c ON e.case_id = c.id WHERE c.client_id = ? AND e.billed = 0 ORDER BY e.entry_date ASC`).all(clientId);
  if (!entries.length) { flash(req, 'error', 'No unbilled entries for this client.'); return res.redirect('/billing'); }

  const invNum = `INV-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  const invInfo = db.prepare(`INSERT INTO invoice (invoice_number, client_id, issue_date, due_date, status) VALUES (?, ?, ?, ?, 'sent')`).run(invNum, clientId, today(), dueDate);
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
  flash(req, 'success', 'Invoice generated from unbilled entries.');
  res.redirect('/billing');
});

router.post('/billing/invoices/:id/payment', requireLogin, requireWebRole('admin', 'lawyer', 'staff'), (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoice WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).send('Invoice not found');
  const b = req.body;
  db.prepare('INSERT INTO payment (invoice_id, amount, payment_date, method, reference) VALUES (?, ?, ?, ?, ?)')
    .run(invoice.id, parseFloat(b.amount||0), b.payment_date||today(), (b.method||'bank_transfer').trim(), (b.reference||'').trim());
  const payments = db.prepare('SELECT * FROM payment WHERE invoice_id = ?').all(invoice.id);
  const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
  const newStatus = paidTotal >= invoice.total ? 'paid' : (paidTotal > 0 ? 'partial' : invoice.status);
  db.prepare('UPDATE invoice SET status=?, updated_at=? WHERE id=?').run(newStatus, now(), invoice.id);
  logActivity(req.session.user.id, `Recorded payment for ${invoice.invoice_number}`, `invoice:${invoice.id}`);
  flash(req, 'success', 'Payment recorded.');
  res.redirect('/billing');
});

// ─── Users ────────────────────────────────────────────────────────────────
router.get('/users', requireLogin, requireWebRole('admin'), (req, res) => {
  const users = db.prepare('SELECT * FROM "user" ORDER BY created_at DESC').all();
  res.render('users/index', { users, fmtDate });
});

router.post('/users', requireLogin, requireWebRole('admin'), (req, res) => {
  const b = req.body;
  const hash = bcrypt.hashSync(b.password || 'TempPass123!', 10);
  db.prepare(`INSERT INTO "user" (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run((b.full_name||'').trim(), (b.email||'').trim().toLowerCase(), hash, (b.role||'staff').trim());
  logActivity(req.session.user.id, `Created user ${b.email}`, `user:${b.email}`);
  flash(req, 'success', 'User created.');
  res.redirect('/users');
});

// ─── Notifications ────────────────────────────────────────────────────────
router.get('/notifications', requireLogin, (req, res) => {
  const user = req.session.user;
  const profile = user.role === 'client' ? getClientProfile(user.id) : null;
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let remQ = `SELECT d.*, c.reference_number AS case_ref FROM deadline d JOIN "case" c ON d.case_id = c.id WHERE d.due_date <= ?`;
  const remArgs = [soon + ' 23:59:59'];
  if (profile) { remQ += ' AND c.client_id = ?'; remArgs.push(profile.id); }
  remQ += ' ORDER BY d.due_date ASC';

  let taskQ = `SELECT t.*, c.reference_number AS case_ref FROM task t JOIN "case" c ON t.case_id = c.id WHERE t.status != 'done' AND t.due_date < ?`;
  const taskArgs = [today()];
  if (profile) { taskQ += ' AND c.client_id = ?'; taskArgs.push(profile.id); }
  else if (['lawyer', 'staff'].includes(user.role)) { taskQ += ' AND t.assignee_id = ?'; taskArgs.push(user.id); }
  taskQ += ' ORDER BY t.due_date ASC';

  res.render('dashboard/notifications', {
    reminders: db.prepare(remQ).all(...remArgs),
    overdue_tasks: db.prepare(taskQ).all(...taskArgs),
    fmtDate, fmtDateTime,
  });
});

module.exports = router;
