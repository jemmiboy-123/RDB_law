'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const { seedAdmin } = require('./src/db');
const apiRouter = require('./src/routes/api');
const webRouter = require('./src/routes/web');

const app = express();

// ─── View engine ──────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Body parsers ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Static files ─────────────────────────────────────────────────────────
app.use('/static', express.static(path.join(__dirname, 'app', 'static')));

// ─── Sessions ─────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SECRET_KEY || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 },
}));

// ─── Flash + auth locals ──────────────────────────────────────────────────
app.use((req, res, next) => {
  // Expose flash messages and clear them after reading
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  res.locals.user = req.session.user || null;
  next();
});

// ─── Seed ─────────────────────────────────────────────────────────────────
seedAdmin();

// ─── Routes ───────────────────────────────────────────────────────────────
app.use('/api', apiRouter);
app.use('/', webRouter);

// ─── React SPA ────────────────────────────────────────────────────────────
const distPath = path.join(__dirname, 'frontend', 'dist');
app.use('/app', express.static(distPath));
app.get('/app*', (req, res) => {
  const idx = path.join(distPath, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(404).send('React app not built. Run `npm run build` inside /frontend.');
});

// ─── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`RDB Law OS running at http://localhost:${PORT}`);
});

module.exports = app;
