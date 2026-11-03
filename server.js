'use strict';

const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const { Pool }   = require('pg');

// ─── Config ────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const DATABASE_URL= process.env.DATABASE_URL;
const GMAIL_USER  = process.env.GMAIL_USER;
const GMAIL_PASS  = process.env.GMAIL_APP_PASSWORD;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'Viiillaz2026';

// ─── Database ──────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inscriptions (
      id           SERIAL PRIMARY KEY,
      prenom       TEXT    NOT NULL,
      nom          TEXT    NOT NULL,
      email        TEXT    NOT NULL UNIQUE,
      nb_personnes INTEGER DEFAULT 1,
      transport    TEXT    DEFAULT 'non',
      telephone    TEXT,
      adresse      TEXT,
      date         TEXT    NOT NULL
    )
  `);
  console.log('✅  Table inscriptions OK');
}

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
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace(/^Bearer\s+/i, '');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ── POST /api/register ──────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { prenom, nom, email, nb_personnes, transport, telephone, adresse } = req.body;

  if (!prenom || !nom || !email)
    return res.status(400).json({ success: false, message: 'Prénom, nom et e-mail sont requis.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ success: false, message: 'Adresse e-mail invalide.' });

  const date = new Date().toISOString();

  try {
    await pool.query(
      `INSERT INTO inscriptions (prenom, nom, email, nb_personnes, transport, telephone, adresse, date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        prenom.trim(),
        nom.trim(),
        email.toLowerCase().trim(),
        Number(nb_personnes) || 1,
        transport === 'oui' ? 'oui' : 'non',
        telephone || null,
        adresse   || null,
        date
      ]
    );

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
    if (err.code === '23505') // unique_violation
      return res.status(409).json({ success: false, message: 'Cette adresse e-mail est déjà inscrite.' });
    console.error('[register error]', err);
    res.status(500).json({ success: false, message: 'Erreur serveur. Veuillez réessayer.' });
  }
});

// ── GET /api/registrations ──────────────────────────────────────────────────
app.get('/api/registrations', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM inscriptions ORDER BY date DESC');
  res.json({ count: rows.length, registrations: rows });
});

// ── GET /api/export ─────────────────────────────────────────────────────────
app.get('/api/export', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM inscriptions ORDER BY date ASC');
  const header = 'ID,Prénom,Nom,Email,Nb personnes,Transport,Téléphone,Adresse,Date\n';
  const csv = rows.map(r =>
    [r.id, r.prenom, r.nom, r.email, r.nb_personnes, r.transport,
     r.telephone || '', r.adresse || '', r.date]
    .map(v => `"${String(v).replace(/"/g, '""')}"`)
    .join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inscriptions-noel-ainees.csv"');
  res.send('﻿' + header + csv);
});

// ── DELETE /api/registrations/:id ───────────────────────────────────────────
app.delete('/api/registrations/:id', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM inscriptions WHERE id = $1', [Number(req.params.id)]);
  if (rowCount === 0) return res.status(404).json({ error: 'Non trouvé' });
  res.json({ success: true });
});

// ── GET /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*) as n FROM inscriptions');
  res.json({ status: 'ok', inscriptions: Number(rows[0].n), timestamp: new Date().toISOString() });
});

// ── Start ───────────────────────────────────────────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`✅  Noël des Aînées API — port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
