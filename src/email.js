'use strict';

const nodemailer = require('nodemailer');

function sendEmailIfConfigured(to, subject, body) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) return;

  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    auth: { user, pass },
  });

  transporter.sendMail({
    from: process.env.SMTP_FROM || 'noreply@lawfirm.local',
    to,
    subject,
    text: body,
  }).catch(err => console.error('Email error:', err.message));
}

module.exports = { sendEmailIfConfigured };
