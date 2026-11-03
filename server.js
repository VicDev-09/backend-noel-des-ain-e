'use strict';

const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const Database   = require('better-sqlite3');
const path       = require('path');
const fs         = require('fs');

// ─── Config ────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'data', 'inscriptions.db');
const GMAIL_USER = process.env.GMAIL_USER;           // compte jeunesse
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;   // App Password Google
const ADMIN_TOKEN= process.env.ADMIN_TOKEN || 'Viiillaz2026';

// ─── Database ──────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS inscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    prenom      TEXT    NOT NULL,
    nom         TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    nb_personnes INTEGER DEFAULT 1,
    transport   TEXT    DEFAULT 'non',
    telephone   TEXT,
    adresse     TEXT,
    date        TEXT    NOT NULL
  )
`);

// ─── Mailer ────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

function emailHtml(prenom, nom, nbPersonnes) {
  const pluriel = nbPersonnes > 1 ? 's' : '';
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#FFFAF5;border-radius:8px">
  <h2 style="color:#6B1A28;font-family:Georgia,serif;margin-bottom:8px">
    🎄 Confirmation d'inscription — Noël des Aînées
  </h2>
  <p style="color:#333">Bonjour <strong>${prenom} ${nom}</strong>,</p>
  <p style="color:#333">
    Nous avons bien reçu votre inscription pour le <strong>Noël des Aînées à Villaz</strong>.
    ${nbPersonnes > 1 ? `Vous serez <strong>${nbPersonnes} personne${pluriel}</strong>.` : ''}
    Merci de votre participation !
  </p>
  <p style="color:#333">
    Nous vous contacterons prochainement avec les détails pratiques de la soirée.
  </p>
  <hr style="border:none;border-top:1px solid #E8D9CF;margin:20px 0">
  <p style="color:#A07A82;font-size:13px">
    Cordialement,<br>
    <strong>Le Comité — Villaz</strong>
  </p>
</div>`;
}

// ─── App ───────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth middleware for admin routes
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace(/^Bearer\s+/i, '');
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// ── POST /api/register ──────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { prenom, nom, email, nb_personnes, transport, telephone, adresse } = req.body;

  // Validation
  if (!prenom || !nom || !email) {
    return res.status(400).json({ success: false, message: 'Prénom, nom et e-mail sont requis.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Adresse e-mail invalide.' });
  }

  // Duplicate check
  const existing = db.prepare('SELECT id FROM inscriptions WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ success: false, message: 'Cette adresse e-mail est déjà inscrite.' });
  }

  const date = new Date().toISOString();

  try {
    // Save
    db.prepare(`
      INSERT INTO inscriptions (prenom, nom, email, nb_personnes, transport, telephone, adresse, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      prenom.trim(),
      nom.trim(),
      email.toLowerCase().trim(),
      Number(nb_personnes) || 1,
      transport === 'oui' ? 'oui' : 'non',
      telephone || null,
      adresse   || null,
      date
    );

    // Send confirmation email (non-blocking on failure)
    if (GMAIL_USER && GMAIL_PASS) {
      transporter.sendMail({
        from:    `"Comité Villaz — Jeunesse" <${GMAIL_USER}>`,
        to:      email,
        subject: "Confirmation d'inscription — Noël des Aînées",
        html:    emailHtml(prenom.trim(), nom.trim(), Number(nb_personnes) || 1)
      }).catch(err => console.error('[email error]', err.message));
    }

    res.json({ success: true, message: 'Inscription enregistrée ! Un e-mail de confirmation vous a été envoyé.' });

  } catch (err) {
    console.error('[register error]', err);
    res.status(500).json({ success: false, message: 'Erreur serveur. Veuillez réessayer.' });
  }
});

// ── GET /api/registrations ──────────────────────────────────────────────────
app.get('/api/registrations', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM inscriptions ORDER BY date DESC').all();
  res.json({ count: rows.length, registrations: rows });
});

// ── GET /api/export ─────────────────────────────────────────────────────────
app.get('/api/export', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM inscriptions ORDER BY date ASC').all();
  const header = 'ID,Prénom,Nom,Email,Nb personnes,Transport,Téléphone,Adresse,Date\n';
  const csv = rows.map(r =>
    [r.id, r.prenom, r.nom, r.email, r.nb_personnes, r.transport,
     r.telephone || '', r.adresse || '', r.date]
    .map(v => `"${String(v).replace(/"/g, '""')}"`)
    .join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inscriptions-noel-ainees.csv"');
  res.send('﻿' + header + csv); // BOM pour Excel
});

// ── DELETE /api/registrations/:id ───────────────────────────────────────────
app.delete('/api/registrations/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM inscriptions WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Non trouvé' });
  res.json({ success: true });
});

// ── GET /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as n FROM inscriptions').get().n;
  res.json({ status: 'ok', inscriptions: count, timestamp: new Date().toISOString() });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅  Noël des Aînées API — port ${PORT}`));
