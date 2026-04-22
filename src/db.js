'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

function now() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

async function logActivity(userId, action, target = '') {
  await supabase.from('activity_logs').insert({ user_id: userId || null, action, target });
}

async function getUserById(id) {
  const { data } = await supabase.from('users').select('*').eq('id', id).single();
  return data;
}

async function getUserByEmail(email) {
  const { data } = await supabase.from('users').select('*').eq('email', email).eq('is_active_user', true).single();
  return data;
}

async function getCaseLawyers(caseId) {
  const { data: cls } = await supabase.from('case_lawyers').select('user_id').eq('case_id', caseId);
  if (!cls || !cls.length) return [];
  const { data } = await supabase.from('users').select('*').in('id', cls.map(r => r.user_id));
  return data || [];
}

async function setCaseLawyers(caseId, lawyerIds) {
  await supabase.from('case_lawyers').delete().eq('case_id', caseId);
  if (lawyerIds && lawyerIds.length) {
    await supabase.from('case_lawyers').insert(lawyerIds.map(id => ({ case_id: caseId, user_id: id })));
  }
}

async function getClientProfile(userId) {
  const { data } = await supabase.from('clients').select('*').eq('portal_user_id', userId).single();
  return data;
}

async function getInvoicePayments(invoiceId) {
  const { data } = await supabase.from('payments').select('*').eq('invoice_id', invoiceId);
  return data || [];
}

async function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@lawfirm.local';
  const { data: existing } = await supabase.from('users').select('id').eq('email', adminEmail).single();
  if (!existing) {
    const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex');
    const hash = bcrypt.hashSync(adminPassword, 10);
    const { error } = await supabase.from('users').insert({
      full_name: 'System Administrator',
      email: adminEmail,
      password_hash: hash,
      role: 'admin',
      is_active_user: true,
    });
    if (error) {
      console.error('Failed to seed admin:', error.message);
    } else {
      console.log(`Admin user created: ${adminEmail}`);
      if (!process.env.ADMIN_PASSWORD) {
        console.log(`Generated admin password: ${adminPassword}`);
        console.log('Save this now — it will not be shown again.');
      }
    }
  }
}

module.exports = {
  supabase,
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
