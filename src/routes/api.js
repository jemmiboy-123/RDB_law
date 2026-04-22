'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const {
  supabase, now, today, logActivity,
  getUserById, getUserByEmail,
  getCaseLawyers, setCaseLawyers,
  getClientProfile, getInvoicePayments,
} = require('../db');
const { sendEmailIfConfigured } = require('../email');
const { requireAuth, requireRole } = require('../middleware/auth');

// ─── File upload ──────────────────────────────────────────────────────────────
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });

function userJson(u) {
  return { id: u.id, full_name: u.full_name, email: u.email, role: u.role, is_active_user: !!u.is_active_user };
}

function clientJson(c) {
  return { id: c.id, full_name: c.full_name, email: c.email, phone: c.phone, address: c.address, company: c.company, notes: c.notes, portal_user_id: c.portal_user_id };
}

async function caseJson(c) {
  const lawyers = await getCaseLawyers(c.id);
  const { data: client } = await supabase.from('clients').select('id, full_name').eq('id', c.client_id).single();
  return {
    id: c.id, title: c.title, reference_number: c.reference_number,
    case_type: c.case_type, description: c.description, status: c.status,
    opened_on: c.opened_on, closed_on: c.closed_on, updated_at: c.updated_at,
    client: client || { id: c.client_id, full_name: '' },
    lawyers: lawyers.map(l => ({ id: l.id, full_name: l.full_name })),
  };
}

async function taskJson(t) {
  const { data: caseRow } = await supabase.from('cases').select('id, reference_number').eq('id', t.case_id).single();
  const { data: assignee } = await supabase.from('users').select('id, full_name').eq('id', t.assignee_id).single();
  return {
    id: t.id,
    case: caseRow || { id: t.case_id, reference_number: '' },
    title: t.title, details: t.details,
    assignee: assignee || { id: t.assignee_id, full_name: '' },
    due_date: t.due_date, status: t.status,
  };
}

async function canViewCase(user, c) {
  if (['admin', 'lawyer', 'staff'].includes(user.role)) return true;
  if (user.role === 'client') {
    const profile = await getClientProfile(user.id);
    return !!(profile && c.client_id === profile.id);
  }
  return false;
}

// ─── Public routes ────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { email = '', password = '' } = req.body;
  const user = await getUserByEmail(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password.trim(), user.password_hash)) {
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

router.post('/auth/change-password', async (req, res) => {
  if (!req.session.user) return err(res, 'Authentication required', 401);
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return err(res, 'current_password and new_password are required');
  if (new_password.length < 8) return err(res, 'new_password must be at least 8 characters');
  const user = await getUserById(req.session.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) return err(res, 'Current password is incorrect', 401);
  const hash = bcrypt.hashSync(new_password, 10);
  await supabase.from('users').update({ password_hash: hash }).eq('id', user.id);
  await logActivity(user.id, 'Changed own password', `user:${user.id}`);
  res.json({ ok: true });
});

// ─── Require auth for everything below ───────────────────────────────────────
router.use(requireAuth);

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const user = req.session.user;
    const profile = user.role === 'client' ? await getClientProfile(user.id) : null;

    let casesQ = supabase.from('cases').select('*').neq('status', 'closed').order('updated_at', { ascending: false }).limit(8);
    if (profile) casesQ = casesQ.eq('client_id', profile.id);
    const { data: rawCases } = await casesQ;
    const activeCases = await Promise.all((rawCases || []).map(caseJson));

    let dlQ = supabase.from('deadlines').select('*, cases(reference_number, client_id)').gte('due_date', today()).order('due_date', { ascending: true }).limit(8);
    const { data: dlData } = await dlQ;
    let upcomingDeadlines = dlData || [];
    if (profile) upcomingDeadlines = upcomingDeadlines.filter(d => d.cases?.client_id === profile.id);

    const { data: recentActivities } = await supabase.from('activity_logs').select('*, users(full_name)').order('created_at', { ascending: false }).limit(12);

    let taskQ = supabase.from('tasks').select('*').neq('status', 'done');
    if (profile) {
      const { data: cc } = await supabase.from('cases').select('id').eq('client_id', profile.id);
      const ids = (cc || []).map(c => c.id);
      if (ids.length) taskQ = taskQ.in('case_id', ids);
    } else if (['lawyer', 'staff'].includes(user.role)) {
      taskQ = taskQ.eq('assignee_id', user.id);
    }
    const { data: taskData } = await taskQ;

    let invQ = supabase.from('invoices').select('*').in('status', ['sent', 'partial']);
    if (user.role === 'client' && profile) invQ = invQ.eq('client_id', profile.id);
    const { data: invData } = await invQ;

    let { count: activeCasesCount } = await supabase.from('cases').select('*', { count: 'exact', head: true }).neq('status', 'closed');
    let { count: deadlinesCount } = await supabase.from('deadlines').select('*', { count: 'exact', head: true }).gte('due_date', today());

    res.json({
      stats: {
        active_cases: activeCasesCount || 0,
        upcoming_deadlines: deadlinesCount || 0,
        open_tasks: (taskData || []).length,
        unpaid_invoices: (invData || []).length,
      },
      active_cases: activeCases,
      upcoming_deadlines: upcomingDeadlines.map(d => ({
        id: d.id, title: d.title, due_date: d.due_date, kind: d.kind,
        case: { id: d.case_id, reference_number: d.cases?.reference_number || '' },
      })),
      recent_activities: (recentActivities || []).map(a => ({
        id: a.id, action: a.action, target: a.target,
        created_at: a.created_at, user: a.users?.full_name || 'System',
      })),
    });
  } catch (e) { err(res, e.message, 500); }
});

// ─── Meta ─────────────────────────────────────────────────────────────────────
router.get('/meta', async (req, res) => {
  try {
    const user = req.session.user;
    const profile = user.role === 'client' ? await getClientProfile(user.id) : null;

    let { data: cases } = await supabase.from('cases').select('id, reference_number, title').order('reference_number', { ascending: true });
    let { data: clients } = await supabase.from('clients').select('id, full_name').order('full_name', { ascending: true });
    let { data: users } = await supabase.from('users').select('id, full_name, role').order('full_name', { ascending: true });

    if (profile) {
      const { data: cc } = await supabase.from('cases').select('id').eq('client_id', profile.id);
      const caseIds = new Set((cc || []).map(c => c.id));
      cases = (cases || []).filter(c => caseIds.has(c.id));
      clients = (clients || []).filter(cl => cl.id === profile.id);
      users = (users || []).filter(u => u.id === user.id);
    }

    res.json({ cases: cases || [], clients: clients || [], users: users || [] });
  } catch (e) { err(res, e.message, 500); }
});

// ─── Clients ──────────────────────────────────────────────────────────────────
router.get('/clients', async (req, res) => {
  try {
    const user = req.session.user;
    if (user.role === 'client') {
      const profile = await getClientProfile(user.id);
      return res.json({ items: profile ? [clientJson(profile)] : [] });
    }
    const q = (req.query.q || '').trim();
    let query = supabase.from('clients').select('*').order('full_name', { ascending: true });
    if (q) query = query.ilike('full_name', `%${q}%`);
    const { data, error } = await query;
    if (error) return err(res, error.message, 500);
    res.json({ items: (data || []).map(clientJson) });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/clients', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const b = req.body;
    const full_name = (b.full_name || '').trim();
    if (!full_name) return err(res, 'full_name is required');
    const { data, error } = await supabase.from('clients').insert({
      full_name,
      email: (b.email || '').trim(),
      phone: (b.phone || '').trim(),
      address: (b.address || '').trim(),
      company: (b.company || '').trim(),
      notes: (b.notes || '').trim(),
      portal_user_id: b.portal_user_id || null,
    }).select().single();
    if (error) return err(res, error.message, 500);
    await logActivity(req.session.user.id, `Created client ${full_name}`, `client:${full_name}`);
    res.status(201).json({ item: clientJson(data) });
  } catch (e) { err(res, e.message, 500); }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const user = req.session.user;
    const { data: client, error } = await supabase.from('clients').select('*').eq('id', req.params.id).single();
    if (!client || error) return err(res, 'Client not found', 404);
    if (user.role === 'client' && client.portal_user_id !== user.id) return err(res, 'Forbidden', 403);
    const { data: rawCases } = await supabase.from('cases').select('*').eq('client_id', client.id).order('created_at', { ascending: false });
    const cases = await Promise.all((rawCases || []).map(caseJson));
    res.json({ item: clientJson(client), case_history: cases });
  } catch (e) { err(res, e.message, 500); }
});

router.put('/clients/:id', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const { data: client, error } = await supabase.from('clients').select('*').eq('id', req.params.id).single();
    if (!client || error) return err(res, 'Client not found', 404);
    const b = req.body;
    const updates = {};
    for (const f of ['full_name', 'email', 'phone', 'address', 'company', 'notes']) {
      if (f in b) updates[f] = (b[f] || '').trim();
    }
    if ('portal_user_id' in b) updates.portal_user_id = b.portal_user_id || null;
    const { data: updated } = await supabase.from('clients').update(updates).eq('id', client.id).select().single();
    await logActivity(req.session.user.id, `Updated client ${client.full_name}`, `client:${client.id}`);
    res.json({ item: clientJson(updated) });
  } catch (e) { err(res, e.message, 500); }
});

// ─── Cases ────────────────────────────────────────────────────────────────────
router.get('/cases', async (req, res) => {
  try {
    const user = req.session.user;
    const profile = user.role === 'client' ? await getClientProfile(user.id) : null;
    let query = supabase.from('cases').select('*').order('updated_at', { ascending: false });
    if (profile) query = query.eq('client_id', profile.id);
    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.q) query = query.ilike('title', `%${req.query.q.trim()}%`);
    const { data, error } = await query;
    if (error) return err(res, error.message, 500);
    res.json({ items: await Promise.all((data || []).map(caseJson)) });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/cases', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const b = req.body;
    const title = (b.title || '').trim();
    const ref = (b.reference_number || '').trim();
    if (!title || !ref || !b.client_id) return err(res, 'title, reference_number, client_id are required');
    const { data: c, error } = await supabase.from('cases').insert({
      title, reference_number: ref,
      case_type: (b.case_type || '').trim(),
      description: (b.description || '').trim(),
      status: b.status || 'open',
      opened_on: b.opened_on || today(),
      client_id: b.client_id,
    }).select().single();
    if (error) return err(res, error.message, 500);
    await setCaseLawyers(c.id, b.lawyer_ids || []);
    await logActivity(req.session.user.id, `Created case ${ref}`, `case:${ref}`);
    res.status(201).json({ item: await caseJson(c) });
  } catch (e) { err(res, e.message, 500); }
});

router.get('/cases/:id', async (req, res) => {
  try {
    const { data: c, error } = await supabase.from('cases').select('*').eq('id', req.params.id).single();
    if (!c || error) return err(res, 'Case not found', 404);
    if (!await canViewCase(req.session.user, c)) return err(res, 'Forbidden', 403);
    const { data: notesRaw } = await supabase.from('case_notes').select('*, users(full_name)').eq('case_id', c.id).order('created_at', { ascending: false });
    const { data: docs } = await supabase.from('documents').select('*').eq('case_id', c.id).order('created_at', { ascending: false }).limit(10);
    const { data: tasksRaw } = await supabase.from('tasks').select('*').eq('case_id', c.id).order('created_at', { ascending: false }).limit(10);
    res.json({
      item: await caseJson(c),
      notes: (notesRaw || []).map(n => ({ id: n.id, body: n.body, author: n.users?.full_name, created_at: n.created_at })),
      documents: (docs || []).map(d => ({ id: d.id, original_name: d.original_name, category: d.category, created_at: d.created_at })),
      tasks: await Promise.all((tasksRaw || []).map(taskJson)),
    });
  } catch (e) { err(res, e.message, 500); }
});

router.put('/cases/:id', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const { data: c, error } = await supabase.from('cases').select('*').eq('id', req.params.id).single();
    if (!c || error) return err(res, 'Case not found', 404);
    const b = req.body;
    const updates = {
      title: 'title' in b ? (b.title || '').trim() : c.title,
      reference_number: 'reference_number' in b ? (b.reference_number || '').trim() : c.reference_number,
      case_type: 'case_type' in b ? (b.case_type || '').trim() : c.case_type,
      description: 'description' in b ? (b.description || '').trim() : c.description,
      status: 'status' in b ? (b.status || 'open') : c.status,
      opened_on: 'opened_on' in b ? (b.opened_on || c.opened_on) : c.opened_on,
      closed_on: 'closed_on' in b ? (b.closed_on || null) : c.closed_on,
      client_id: 'client_id' in b ? b.client_id : c.client_id,
    };
    const { data: updated } = await supabase.from('cases').update(updates).eq('id', c.id).select().single();
    if ('lawyer_ids' in b) await setCaseLawyers(c.id, b.lawyer_ids || []);
    await logActivity(req.session.user.id, `Updated case ${updates.reference_number}`, `case:${c.id}`);
    res.json({ item: await caseJson(updated) });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/cases/:id/notes', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const { data: c, error } = await supabase.from('cases').select('*').eq('id', req.params.id).single();
    if (!c || error) return err(res, 'Case not found', 404);
    const body = (req.body.body || '').trim();
    if (!body) return err(res, 'body is required');
    const { data: note } = await supabase.from('case_notes').insert({ case_id: c.id, author_id: req.session.user.id, body }).select().single();
    await logActivity(req.session.user.id, `Added note to ${c.reference_number}`, `case:${c.id}`);
    res.status(201).json({ item: { id: note.id, body: note.body, author: req.session.user.full_name, created_at: note.created_at } });
  } catch (e) { err(res, e.message, 500); }
});

// ─── Documents ────────────────────────────────────────────────────────────────
router.get('/documents', async (req, res) => {
  try {
    const user = req.session.user;
    const profile = user.role === 'client' ? await getClientProfile(user.id) : null;
    let query = supabase.from('documents').select('*, cases(reference_number, client_id)').order('created_at', { ascending: false });
    if (req.query.q) query = query.ilike('original_name', `%${req.query.q.trim()}%`);
    if (req.query.case_id) query = query.eq('case_id', parseInt(req.query.case_id));
    const { data, error } = await query;
    if (error) return err(res, error.message, 500);
    let docs = data || [];
    if (profile) docs = docs.filter(d => d.cases?.client_id === profile.id);
    res.json({ items: docs.map(d => ({ id: d.id, original_name: d.original_name, category: d.category, description: d.description, created_at: d.created_at, case: { id: d.case_id, reference_number: d.cases?.reference_number || '' } })) });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/documents', requireRole('admin', 'lawyer', 'staff'), upload.single('file'), async (req, res) => {
  try {
    const caseId = parseInt(req.body.case_id);
    const { data: caseRow, error } = await supabase.from('cases').select('*').eq('id', caseId).single();
    if (!caseRow || error) return err(res, 'Valid case_id is required');
    if (!req.file) return err(res, 'Unsupported or missing file');
    const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const { data: doc } = await supabase.from('documents').insert({ case_id: caseRow.id, uploaded_by_id: req.session.user.id, filename: req.file.filename, original_name: safeName, category: (req.body.category || 'General').trim(), description: (req.body.description || '').trim() }).select().single();
    await logActivity(req.session.user.id, `Uploaded document for ${caseRow.reference_number}`, `document:${safeName}`);
    res.status(201).json({ item: { id: doc.id, original_name: safeName } });
  } catch (e) { err(res, e.message, 500); }
});

router.get('/documents/:id/download', async (req, res) => {
  try {
    const { data: doc, error } = await supabase.from('documents').select('*').eq('id', req.params.id).single();
    if (!doc || error) return err(res, 'Document not found', 404);
    const { data: caseRow } = await supabase.from('cases').select('*').eq('id', doc.case_id).single();
    if (!await canViewCase(req.session.user, caseRow)) return err(res, 'Forbidden', 403);
    res.download(path.join(__dirname, '..', '..', 'app', 'uploads', doc.filename), doc.original_name);
  } catch (e) { err(res, e.message, 500); }
});

// ─── Calendar ─────────────────────────────────────────────────────────────────
router.get('/calendar', async (req, res) => {
  try {
    const user = req.session.user;
    const profile = user.role === 'client' ? await getClientProfile(user.id) : null;
    const { data, error } = await supabase.from('deadlines').select('*, cases(reference_number, client_id)').gte('due_date', today()).order('due_date', { ascending: true });
    if (error) return err(res, error.message, 500);
    let items = data || [];
    if (profile) items = items.filter(d => d.cases?.client_id === profile.id);
    res.json({ items: items.map(d => ({ id: d.id, title: d.title, due_date: d.due_date, kind: d.kind, case: { id: d.case_id, reference_number: d.cases?.reference_number || '' } })) });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/calendar', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.case_id || !b.title || !b.due_date) return err(res, 'case_id, title, due_date are required');
    const { data: caseRow, error } = await supabase.from('cases').select('*').eq('id', b.case_id).single();
    if (!caseRow || error) return err(res, 'Case not found', 404);
    const { data: deadline } = await supabase.from('deadlines').insert({ case_id: b.case_id, title: (b.title || '').trim(), due_date: b.due_date, kind: (b.kind || 'deadline').trim() }).select().single();
    const lawyers = await getCaseLawyers(b.case_id);
    for (const l of lawyers) {
      if (l.email) sendEmailIfConfigured(l.email, `New ${b.kind} for ${caseRow.reference_number}`, `${b.title} is scheduled on ${b.due_date}.`);
    }
    await logActivity(req.session.user.id, `Added ${b.kind} for ${caseRow.reference_number}`, `deadline:${deadline.id}`);
    res.status(201).json({ item: { id: deadline.id } });
  } catch (e) { err(res, e.message, 500); }
});

// ─── Tasks ────────────────────────────────────────────────────────────────────
router.get('/tasks', async (req, res) => {
  try {
    const user = req.session.user;
    const profile = user.role === 'client' ? await getClientProfile(user.id) : null;
    let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (profile) {
      const { data: cc } = await supabase.from('cases').select('id').eq('client_id', profile.id);
      const ids = (cc || []).map(c => c.id);
      if (ids.length) query = query.in('case_id', ids);
    } else if (req.query.mine === '1' || ['lawyer', 'staff'].includes(user.role)) {
      query = query.eq('assignee_id', user.id);
    }
    const { data, error } = await query;
    if (error) return err(res, error.message, 500);
    res.json({ items: await Promise.all((data || []).map(taskJson)) });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/tasks', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.case_id || !b.title || !b.assignee_id) return err(res, 'case_id, title, assignee_id are required');
    const { data: task } = await supabase.from('tasks').insert({ case_id: b.case_id, title: (b.title || '').trim(), details: (b.details || '').trim(), assignee_id: b.assignee_id, due_date: b.due_date || null, status: (b.status || 'todo').trim() }).select().single();
    const { data: assignee } = await supabase.from('users').select('*').eq('id', b.assignee_id).single();
    if (assignee?.email) sendEmailIfConfigured(assignee.email, `Task assigned: ${b.title}`, `You have been assigned task '${b.title}'.`);
    await logActivity(req.session.user.id, `Created task ${b.title}`, `task:${task.id}`);
    res.status(201).json({ item: await taskJson(task) });
  } catch (e) { err(res, e.message, 500); }
});

router.put('/tasks/:id/status', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const { data: task, error } = await supabase.from('tasks').select('*').eq('id', req.params.id).single();
    if (!task || error) return err(res, 'Task not found', 404);
    const user = req.session.user;
    if (['lawyer', 'staff'].includes(user.role) && task.assignee_id !== user.id) return err(res, 'Forbidden', 403);
    const status = req.body.status || 'todo';
    const { data: updated } = await supabase.from('tasks').update({ status }).eq('id', task.id).select().single();
    await logActivity(user.id, `Updated task status to ${status}`, `task:${task.id}`);
    res.json({ item: await taskJson(updated) });
  } catch (e) { err(res, e.message, 500); }
});

// ─── Billing ──────────────────────────────────────────────────────────────────
router.get('/billing', async (req, res) => {
  try {
    const user = req.session.user;
    const profile = user.role === 'client' ? await getClientProfile(user.id) : null;

    let entryQ = supabase.from('time_entries').select('*, cases(reference_number, client_id), users(full_name)').order('entry_date', { ascending: false }).limit(50);
    let invQ = supabase.from('invoices').select('*, clients(full_name)').order('created_at', { ascending: false }).limit(25);
    if (profile) invQ = invQ.eq('client_id', profile.id);

    const { data: entries } = await entryQ;
    const { data: invoices } = await invQ;

    let filteredEntries = entries || [];
    if (profile) filteredEntries = filteredEntries.filter(e => e.cases?.client_id === profile.id);

    res.json({
      entries: filteredEntries.map(e => ({ id: e.id, entry_date: e.entry_date, hours: e.hours, rate: e.rate, description: e.description, billed: !!e.billed, case: { id: e.case_id, reference_number: e.cases?.reference_number || '' }, lawyer: { id: e.lawyer_id, full_name: e.users?.full_name || '' } })),
      invoices: (invoices || []).map(i => ({ id: i.id, invoice_number: i.invoice_number, status: i.status, total: i.total, client: { id: i.client_id, full_name: i.clients?.full_name || '' } })),
    });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/billing/time-entries', requireRole('admin', 'lawyer'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.case_id || !b.lawyer_id || !b.description) return err(res, 'case_id, lawyer_id, description are required');
    const { data: entry } = await supabase.from('time_entries').insert({ case_id: b.case_id, lawyer_id: b.lawyer_id, entry_date: b.entry_date || today(), hours: parseFloat(b.hours || 0), rate: parseFloat(b.rate || 0), description: (b.description || '').trim() }).select().single();
    await logActivity(req.session.user.id, `Added billable entry (${b.hours}h)`, `case:${b.case_id}`);
    res.status(201).json({ item: { id: entry.id } });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/billing/invoices', requireRole('admin', 'lawyer'), async (req, res) => {
  try {
    const b = req.body;
    const clientId = b.client_id;
    const taxRate = parseFloat(b.tax_rate || 0);
    const { data: cc } = await supabase.from('cases').select('id').eq('client_id', clientId);
    const caseIds = (cc || []).map(c => c.id);
    if (!caseIds.length) return err(res, 'No unbilled entries for this client');
    const { data: entries } = await supabase.from('time_entries').select('*').in('case_id', caseIds).eq('billed', false).order('entry_date', { ascending: true });
    if (!entries || !entries.length) return err(res, 'No unbilled entries for this client');
    const invNum = `INV-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
    const { data: invoice } = await supabase.from('invoices').insert({ invoice_number: invNum, client_id: clientId, issue_date: today(), due_date: b.due_date || today(), status: 'sent' }).select().single();
    let subtotal = 0;
    const items = entries.map(e => { const amount = e.hours * e.rate; subtotal += amount; return { invoice_id: invoice.id, time_entry_id: e.id, description: `${e.entry_date} - ${e.description}`, quantity: e.hours, unit_price: e.rate, line_total: amount }; });
    await supabase.from('invoice_items').insert(items);
    await supabase.from('time_entries').update({ billed: true }).in('id', entries.map(e => e.id));
    const tax = Math.round(subtotal * (taxRate / 100) * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    await supabase.from('invoices').update({ subtotal: Math.round(subtotal * 100) / 100, tax, total }).eq('id', invoice.id);
    await logActivity(req.session.user.id, `Generated invoice ${invNum}`, `invoice:${invoice.id}`);
    res.status(201).json({ item: { id: invoice.id, invoice_number: invNum } });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/billing/invoices/:id/payments', requireRole('admin', 'lawyer', 'staff'), async (req, res) => {
  try {
    const { data: invoice, error } = await supabase.from('invoices').select('*').eq('id', req.params.id).single();
    if (!invoice || error) return err(res, 'Invoice not found', 404);
    const b = req.body;
    const { data: payment } = await supabase.from('payments').insert({ invoice_id: invoice.id, amount: parseFloat(b.amount || 0), payment_date: b.payment_date || today(), method: (b.method || 'bank_transfer').trim(), reference: (b.reference || '').trim() }).select().single();
    const payments = await getInvoicePayments(invoice.id);
    const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
    const newStatus = paidTotal >= invoice.total ? 'paid' : (paidTotal > 0 ? 'partial' : invoice.status);
    await supabase.from('invoices').update({ status: newStatus }).eq('id', invoice.id);
    await logActivity(req.session.user.id, `Recorded payment for ${invoice.invoice_number}`, `invoice:${invoice.id}`);
    res.status(201).json({ item: { id: payment.id } });
  } catch (e) { err(res, e.message, 500); }
});

// ─── Users ────────────────────────────────────────────────────────────────────
router.get('/users', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').order('created_at', { ascending: false });
    if (error) return err(res, error.message, 500);
    res.json({ items: (data || []).map(userJson) });
  } catch (e) { err(res, e.message, 500); }
});

router.post('/users', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body;
    const full_name = (b.full_name || '').trim();
    const email = (b.email || '').trim().toLowerCase();
    if (!full_name || !email) return err(res, 'full_name and email are required');
    const generatedPassword = !b.password ? crypto.randomBytes(12).toString('base64url') : null;
    const hash = bcrypt.hashSync(b.password || generatedPassword, 10);
    const { data, error } = await supabase.from('users').insert({ full_name, email, password_hash: hash, role: (b.role || 'staff').trim(), is_active_user: true }).select().single();
    if (error) return err(res, error.message, 500);
    await logActivity(req.session.user.id, `Created user ${email}`, `user:${email}`);
    res.status(201).json({ item: userJson(data), ...(generatedPassword ? { temporary_password: generatedPassword } : {}) });
  } catch (e) { err(res, e.message, 500); }
});

// ─── Notifications ────────────────────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
  try {
    const user = req.session.user;
    const profile = user.role === 'client' ? await getClientProfile(user.id) : null;
    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let remQ = supabase.from('deadlines').select('*, cases(reference_number, client_id)').lte('due_date', soon).order('due_date', { ascending: true });
    let taskQ = supabase.from('tasks').select('*').neq('status', 'done').lt('due_date', today()).order('due_date', { ascending: true });
    if (['lawyer', 'staff'].includes(user.role)) taskQ = taskQ.eq('assignee_id', user.id);
    const { data: remData } = await remQ;
    const { data: taskData } = await taskQ;
    let reminders = remData || [];
    let overdueTasks = taskData || [];
    if (profile) {
      reminders = reminders.filter(d => d.cases?.client_id === profile.id);
      const { data: cc } = await supabase.from('cases').select('id').eq('client_id', profile.id);
      const caseIds = new Set((cc || []).map(c => c.id));
      overdueTasks = overdueTasks.filter(t => caseIds.has(t.case_id));
    }
    res.json({
      reminders: reminders.map(d => ({ id: d.id, title: d.title, due_date: d.due_date, case: { id: d.case_id, reference_number: d.cases?.reference_number || '' } })),
      overdue_tasks: await Promise.all(overdueTasks.map(taskJson)),
    });
  } catch (e) { err(res, e.message, 500); }
});

module.exports = router;
