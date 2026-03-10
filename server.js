// ═══════════════════════════════════════════════════════
//  SERVER — Kommo Clínica Dashboard
// ═══════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const path    = require('path');
const axios   = require('axios');
const store   = require('./lib/store');
const kommo   = require('./lib/kommo');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth Routes ─────────────────────────────────────

// GET /auth/connect?subdomain=X — Redirect to Kommo OAuth
app.get('/auth/connect', (req, res) => {
  const subdomain = req.query.subdomain;
  if (!subdomain) return res.status(400).json({ error: 'subdomain obrigatório' });
  const url = `https://www.kommo.com/oauth?` + new URLSearchParams({
    client_id: process.env.KOMMO_CLIENT_ID,
    mode: 'popup',
    state: subdomain,
  });
  res.redirect(url);
});

// GET /auth/callback — Handle OAuth callback
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state: subdomain, referer } = req.query;
    const sub = subdomain || (referer ? new URL(String(referer)).hostname.split('.')[0] : null);
    if (!code || !sub) return res.status(400).send('Parâmetros inválidos');
    const { data } = await axios.post(`https://${sub}.kommo.com/oauth2/access_token`, {
      client_id:     process.env.KOMMO_CLIENT_ID,
      client_secret: process.env.KOMMO_CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  process.env.KOMMO_REDIRECT_URI,
    });
    store.upsertOAuth(sub, {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_in:    data.expires_in,
    });
    res.send(`<html><body style="font-family:'Outfit',sans-serif;text-align:center;padding:60px;background:#0f1f21;color:#d4e8e8">
      <h2 style="color:#7ec8c8">✅ Conta "${sub}" conectada com sucesso!</h2>
      <p style="margin-top:20px"><a href="/" style="color:#5ddba8;text-decoration:none;font-weight:600">Ir para o Dashboard →</a></p>
    </body></html>`);
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.status(500).send('Erro na autenticação OAuth');
  }
});

// POST /auth/token — Store long-lived token
app.post('/auth/token', (req, res) => {
  const { subdomain, token, expires_at } = req.body;
  if (!subdomain || !token) return res.status(400).json({ error: 'subdomain e token obrigatórios' });
  store.upsertLongLived(subdomain, { token, expires_at: expires_at || null });
  res.json({ ok: true, subdomain });
});

// GET /auth/accounts — List connected accounts
app.get('/auth/accounts', (req, res) => res.json(store.listAccounts()));

// DELETE /auth/accounts/:subdomain — Remove account
app.delete('/auth/accounts/:subdomain', (req, res) => {
  store.removeAccount(req.params.subdomain);
  res.json({ ok: true });
});

// ─── Health Check (Railway) ──────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── API Routes ──────────────────────────────────────

// GET /api/filters?subdomain=X — Pipelines, users, sources for filter dropdowns
app.get('/api/filters', async (req, res) => {
  try {
    const { subdomain } = req.query;
    if (!subdomain) return res.status(400).json({ error: 'subdomain obrigatório' });
    const data = await kommo.getFiltersData(subdomain);
    res.json(data);
  } catch (err) {
    console.error('Filters error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard?subdomain=X&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&...
app.get('/api/dashboard', async (req, res) => {
  try {
    const { subdomain, date_from, date_to, pipeline_id, responsible_user_id, source_field_value } = req.query;
    if (!subdomain) return res.status(400).json({ error: 'subdomain obrigatório' });
    const data = await kommo.buildDashboardData(subdomain, {
      date_from, date_to,
      pipeline_id: pipeline_id || undefined,
      responsible_user_id: responsible_user_id || undefined,
      source_field_value: source_field_value || undefined,
    });
    res.json(data);
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'tokens.db'));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Initialize store
store.getDb();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🏥 Kommo Clínica Dashboard`);
  console.log(`  ─────────────────────────`);
  console.log(`  🌐 http://0.0.0.0:${PORT}`);
  console.log(`  📂 DB: ${process.env.DB_PATH || './data/tokens.db'}\n`);
});
