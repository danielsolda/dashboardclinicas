// ═══════════════════════════════════════════════════════
//  SERVER — Kommo Clínica Dashboard v2
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
      <h2 style="color:#7ec8c8">✅ Conta "${sub}" conectada!</h2>
      <p style="margin-top:20px"><a href="/" style="color:#5ddba8;text-decoration:none;font-weight:600">Ir para o Dashboard →</a></p>
      <script>if(window.opener){window.opener.postMessage('kommo_connected','*');setTimeout(()=>window.close(),2000)}</script>
    </body></html>`);
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.status(500).send('Erro na autenticação OAuth');
  }
});

app.post('/auth/token', (req, res) => {
  const { subdomain, token, expires_at } = req.body;
  if (!subdomain || !token) return res.status(400).json({ error: 'subdomain e token obrigatórios' });
  store.upsertLongLived(subdomain, { token, expires_at: expires_at || null });
  res.json({ ok: true, subdomain });
});

app.get('/auth/accounts', (req, res) => res.json(store.listAccounts()));

app.delete('/auth/accounts/:subdomain', (req, res) => {
  store.removeAccount(req.params.subdomain);
  res.json({ ok: true });
});

// ─── Health ──────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── API Routes ──────────────────────────────────────

// Helper: parse comma-separated string to int array
function parseIds(val) {
  if (!val) return undefined;
  return String(val).split(',').map(Number).filter(n => !isNaN(n) && n > 0);
}

app.get('/api/filters', async (req, res) => {
  try {
    const { subdomain } = req.query;
    if (!subdomain) return res.status(400).json({ error: 'subdomain obrigatório' });
    const data = await kommo.getFiltersData(subdomain);
    res.json(data);
  } catch (err) {
    console.error('Filters error:', err.message);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err.message, kommo_path: err.kommoPath });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const {
      subdomain, date_from, date_to, date_mode,
      pipeline_ids, status_ids, user_ids,
      source_field_value,
    } = req.query;
    if (!subdomain) return res.status(400).json({ error: 'subdomain obrigatório' });

    const data = await kommo.buildDashboardData(subdomain, {
      date_from:          date_from || undefined,
      date_to:            date_to || undefined,
      date_mode:          date_mode || 'created_at',
      pipeline_ids:       parseIds(pipeline_ids),
      status_ids:         parseIds(status_ids),
      user_ids:           parseIds(user_ids),
      source_field_value: source_field_value || undefined,
    });
    res.json(data);
  } catch (err) {
    console.error('Dashboard error:', err.message);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err.message, kommo_path: err.kommoPath });
  }
});

// GET/POST /api/business-hours?subdomain=X
app.get('/api/business-hours', (req, res) => {
  const { subdomain } = req.query;
  if (!subdomain) return res.status(400).json({ error: 'subdomain obrigatório' });
  res.json(store.getBusinessHours(subdomain));
});

app.post('/api/business-hours', (req, res) => {
  const { subdomain, work_days, start_time, end_time, sla_target_minutes } = req.body;
  if (!subdomain) return res.status(400).json({ error: 'subdomain obrigatório' });
  store.upsertBusinessHours(subdomain, {
    work_days: work_days || '1,2,3,4,5',
    start_time: start_time || '08:00',
    end_time: end_time || '18:00',
    sla_target_minutes: sla_target_minutes || 30,
  });
  res.json({ ok: true });
});

// GET /api/sla?subdomain=X&date_from=&date_to=&pipeline_ids=&user_ids=
app.get('/api/sla', async (req, res) => {
  try {
    const { subdomain, date_from, date_to, date_mode, pipeline_ids, user_ids } = req.query;
    if (!subdomain) return res.status(400).json({ error: 'subdomain obrigatório' });

    const bh = store.getBusinessHours(subdomain);

    const data = await kommo.buildSLAData(subdomain, {
      date_from:       date_from || undefined,
      date_to:         date_to || undefined,
      date_mode:       date_mode || 'created_at',
      pipeline_ids:    parseIds(pipeline_ids),
      user_ids:        parseIds(user_ids),
      business_hours:  bh,
    });
    res.json(data);
  } catch (err) {
    console.error('SLA error:', err.message);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err.message, kommo_path: err.kommoPath });
  }
});

// ─── Debug: Inspect lead events for SLA diagnosis ────

app.get('/api/debug/lead-events', async (req, res) => {
  try {
    const { subdomain, lead_id } = req.query;
    if (!subdomain || !lead_id) return res.status(400).json({ error: 'subdomain and lead_id required' });
    const data = await kommo.debugLeadEvents(subdomain, Number(lead_id));
    res.json(data);
  } catch (err) {
    console.error('Debug error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────

const fs = require('fs');
const dataDir = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'tokens.db'));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
store.getDb();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🏥 Kommo Clínica Dashboard v2`);
  console.log(`  ─────────────────────────────`);
  console.log(`  🌐 http://0.0.0.0:${PORT}`);
  console.log(`  📂 DB: ${process.env.DB_PATH || './data/tokens.db'}\n`);
});
