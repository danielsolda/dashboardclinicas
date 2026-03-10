// ═══════════════════════════════════════════════════════
//  KOMMO API CLIENT — Dashboard Clínica Comercial
// ═══════════════════════════════════════════════════════

const axios = require('axios');
const store = require('./store');

const PAGE_LIMIT = 250;
const TZ_OFFSET = process.env.TZ_OFFSET || '-03:00';

// ─── Token helpers ───────────────────────────────────

async function refreshOAuthToken(subdomain, account) {
  const { data } = await axios.post(`https://${subdomain}.kommo.com/oauth2/access_token`, {
    client_id:     process.env.KOMMO_CLIENT_ID,
    client_secret: process.env.KOMMO_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: account.refresh_token,
    redirect_uri:  process.env.KOMMO_REDIRECT_URI,
  });
  store.upsertOAuth(subdomain, {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_in:    data.expires_in,
  });
  return data.access_token;
}

async function getToken(subdomain) {
  const acct = store.getAccount(subdomain);
  if (!acct) throw new Error(`Conta "${subdomain}" não encontrada.`);
  if (acct.auth_mode === 'long_lived') return acct.long_lived_token;
  const now = Math.floor(Date.now() / 1000);
  if (acct.expires_at - now < 300) return refreshOAuthToken(subdomain, acct);
  return acct.access_token;
}

// ─── HTTP helpers ────────────────────────────────────

async function api(subdomain, method, path, params = {}, data = null) {
  const token = await getToken(subdomain);
  const url   = `https://${subdomain}.kommo.com${path}`;
  const res   = await axios({ method, url, headers: { Authorization: `Bearer ${token}` }, params, data });
  return res.data;
}

async function apiAll(subdomain, path, params = {}, embeddedKey) {
  let page = 1, all = [];
  while (true) {
    const res   = await api(subdomain, 'GET', path, { ...params, limit: PAGE_LIMIT, page });
    const items = res?._embedded?.[embeddedKey] || [];
    if (!items.length) break;
    all = all.concat(items);
    if (items.length < PAGE_LIMIT) break;
    page++;
  }
  return all;
}

// ─── Date helpers ────────────────────────────────────

function toTimestamp(dateStr) {
  return Math.floor(new Date(`${dateStr}T00:00:00${TZ_OFFSET}`).getTime() / 1000);
}

function toTimestampEnd(dateStr) {
  return Math.floor(new Date(`${dateStr}T23:59:59${TZ_OFFSET}`).getTime() / 1000);
}

// ─── Domain endpoints ────────────────────────────────

async function getPipelines(subdomain) {
  const res = await api(subdomain, 'GET', '/api/v4/leads/pipelines');
  return (res?._embedded?.pipelines || []).filter(p => !p.is_archive);
}

async function getUsers(subdomain) {
  return apiAll(subdomain, '/api/v4/users', {}, 'users');
}

async function getLeads(subdomain, filters = {}) {
  const params = { with: 'custom_fields_values' };
  if (filters.pipeline_id)         params['filter[pipeline_id]']            = filters.pipeline_id;
  if (filters.responsible_user_id) params['filter[responsible_user_id]']    = filters.responsible_user_id;
  if (filters.created_from)        params['filter[created_at][from]']       = filters.created_from;
  if (filters.created_to)          params['filter[created_at][to]']         = filters.created_to;
  if (filters.closed_from)         params['filter[closed_at][from]']        = filters.closed_from;
  if (filters.closed_to)           params['filter[closed_at][to]']          = filters.closed_to;
  // Status filters for won/lost
  if (filters.statuses) {
    filters.statuses.forEach((s, i) => {
      params[`filter[statuses][${i}][pipeline_id]`] = s.pipeline_id;
      params[`filter[statuses][${i}][status_id]`]   = s.status_id;
    });
  }
  return apiAll(subdomain, '/api/v4/leads', params, 'leads');
}

async function getEvents(subdomain, filters = {}) {
  const params = {};
  if (filters.type)         params['filter[type]']             = filters.type;
  if (filters.created_from) params['filter[created_at][from]'] = filters.created_from;
  if (filters.created_to)   params['filter[created_at][to]']   = filters.created_to;
  return apiAll(subdomain, '/api/v4/events', params, 'events');
}

async function getSourceFieldOptions(subdomain) {
  const fieldId = process.env.KOMMO_SOURCE_FIELD_ID;
  if (!fieldId) return [];
  try {
    const res = await api(subdomain, 'GET', `/api/v4/leads/custom_fields/${fieldId}`);
    return (res?.enums || []).map(e => ({ enum_id: e.id, label: e.value }));
  } catch { return []; }
}

// ─── Dashboard data builder (clinic focused) ─────────

async function buildDashboardData(subdomain, options = {}) {
  const { date_from, date_to, pipeline_id, responsible_user_id, source_field_value } = options;

  // Build filter params
  const leadFilter = {};
  if (pipeline_id)          leadFilter.pipeline_id          = pipeline_id;
  if (responsible_user_id)  leadFilter.responsible_user_id  = responsible_user_id;
  if (date_from)            leadFilter.created_from         = toTimestamp(date_from);
  if (date_to)              leadFilter.created_to           = toTimestampEnd(date_to);

  // Fetch data in parallel (max 5 concurrent)
  const [pipelines, users, allLeads, sourceOptions] = await Promise.all([
    getPipelines(subdomain),
    getUsers(subdomain),
    getLeads(subdomain, leadFilter),
    getSourceFieldOptions(subdomain),
  ]);

  const sourceFieldId = process.env.KOMMO_SOURCE_FIELD_ID ? Number(process.env.KOMMO_SOURCE_FIELD_ID) : null;

  // Helper: get custom field value
  const getCF = (lead, fieldId) => {
    const cf = (lead.custom_fields_values || []).find(f => f.field_id === fieldId);
    return cf?.values?.[0]?.value || null;
  };

  // Filter by source if requested
  let leads = allLeads;
  if (source_field_value && sourceFieldId) {
    leads = leads.filter(l => getCF(l, sourceFieldId) === source_field_value);
  }

  // Map users
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  // Map pipelines & statuses
  const pipelineMap = {};
  const statusMap = {};
  pipelines.forEach(p => {
    pipelineMap[p.id] = p.name;
    const statuses = p._embedded?.statuses || [];
    statuses.forEach(s => {
      statusMap[`${p.id}-${s.id}`] = { name: s.name, color: s.color, sort: s.sort, pipeline: p.name };
    });
  });

  // Classify leads
  const WON_ID = 142;
  const LOST_ID = 143;
  const now = Math.floor(Date.now() / 1000);

  let totalRevenue = 0, wonCount = 0, lostCount = 0, activeCount = 0;
  let totalCycleDays = 0, cycleCount = 0;
  const byUser = {}, bySource = {}, byStatus = {}, byPipeline = {};
  const byMonth = {};
  const wonLeads = [];

  leads.forEach(lead => {
    const isWon  = lead.status_id === WON_ID;
    const isLost = lead.status_id === LOST_ID;
    const price  = lead.price || 0;
    const userId = lead.responsible_user_id;
    const userName = userMap[userId] || `User ${userId}`;
    const pKey = lead.pipeline_id;
    const sKey = `${lead.pipeline_id}-${lead.status_id}`;
    const statusInfo = statusMap[sKey] || { name: 'Desconhecido', color: '#666' };
    const source = sourceFieldId ? (getCF(lead, sourceFieldId) || 'Sem origem') : 'N/A';

    // KPIs
    if (isWon) {
      wonCount++;
      totalRevenue += price;
      // Cycle time (created → closed)
      if (lead.closed_at && lead.created_at) {
        const days = (lead.closed_at - lead.created_at) / 86400;
        totalCycleDays += days;
        cycleCount++;
      }
      wonLeads.push({
        id: lead.id,
        name: lead.name,
        price,
        responsible: userName,
        created_at: lead.created_at,
        closed_at: lead.closed_at,
        source,
      });
      // Monthly revenue
      const d = new Date(lead.closed_at * 1000);
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      byMonth[mk] = (byMonth[mk] || 0) + price;
    } else if (isLost) {
      lostCount++;
    } else {
      activeCount++;
    }

    // By user
    if (!byUser[userId]) byUser[userId] = { name: userName, won: 0, lost: 0, active: 0, revenue: 0, count: 0 };
    byUser[userId].count++;
    if (isWon)  { byUser[userId].won++; byUser[userId].revenue += price; }
    if (isLost) byUser[userId].lost++;
    if (!isWon && !isLost) byUser[userId].active++;

    // By source
    if (!bySource[source]) bySource[source] = { won: 0, lost: 0, active: 0, revenue: 0, count: 0 };
    bySource[source].count++;
    if (isWon)  { bySource[source].won++; bySource[source].revenue += price; }
    if (isLost) bySource[source].lost++;
    if (!isWon && !isLost) bySource[source].active++;

    // By status (for funnel)
    if (!byStatus[sKey]) byStatus[sKey] = { ...statusInfo, count: 0, value: 0 };
    byStatus[sKey].count++;
    byStatus[sKey].value += price;

    // By pipeline
    if (!byPipeline[pKey]) byPipeline[pKey] = { name: pipelineMap[pKey] || `Pipeline ${pKey}`, count: 0, revenue: 0, won: 0, lost: 0 };
    byPipeline[pKey].count++;
    if (isWon) { byPipeline[pKey].won++; byPipeline[pKey].revenue += price; }
    if (isLost) byPipeline[pKey].lost++;
  });

  const totalLeads = leads.length;
  const convRate = totalLeads > 0 ? ((wonCount / totalLeads) * 100) : 0;
  const convOppToWon = (wonCount + lostCount) > 0 ? ((wonCount / (wonCount + lostCount)) * 100) : 0;
  const avgCycleDays = cycleCount > 0 ? (totalCycleDays / cycleCount) : 0;
  const avgTicket = wonCount > 0 ? (totalRevenue / wonCount) : 0;

  // Sort users by revenue
  const userRanking = Object.values(byUser).sort((a, b) => b.revenue - a.revenue);

  // Sort sources by count
  const sourceBreakdown = Object.entries(bySource)
    .map(([name, d]) => ({ name, ...d, conversion: d.count > 0 ? ((d.won / d.count) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  // Funnel: statuses sorted by pipeline sort → status sort
  const funnel = Object.values(byStatus).sort((a, b) => (a.sort || 0) - (b.sort || 0));

  // Monthly revenue sorted
  const monthlyRevenue = Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, revenue]) => ({ month, revenue }));

  // Won leads sorted by closed_at desc (last 50)
  wonLeads.sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0));

  // Loss reasons by last status before lost (from pipeline status)
  const lossByStatus = {};
  leads.filter(l => l.status_id === LOST_ID).forEach(l => {
    const sKey = `${l.pipeline_id}-${l.status_id}`;
    const info = statusMap[sKey] || { name: 'Perdido' };
    // Note: Kommo doesn't track "previous status" directly on lead.
    // We track losses per pipeline for now.
    const pName = pipelineMap[l.pipeline_id] || 'Pipeline';
    lossByStatus[pName] = (lossByStatus[pName] || 0) + 1;
  });

  return {
    kpis: {
      total_leads: totalLeads,
      active_leads: activeCount,
      won: wonCount,
      lost: lostCount,
      revenue: totalRevenue,
      conv_rate: Math.round(convRate * 10) / 10,
      conv_opp_to_won: Math.round(convOppToWon * 10) / 10,
      avg_cycle_days: Math.round(avgCycleDays * 10) / 10,
      avg_ticket: Math.round(avgTicket),
    },
    user_ranking: userRanking.slice(0, 20),
    source_breakdown: sourceBreakdown,
    funnel,
    monthly_revenue: monthlyRevenue,
    won_leads: wonLeads.slice(0, 50),
    loss_by_pipeline: Object.entries(lossByStatus).map(([name, count]) => ({ name, count })),
    pipelines_summary: Object.values(byPipeline),
  };
}

// ─── Filters endpoint data ───────────────────────────

async function getFiltersData(subdomain) {
  const [pipelines, users, sourceOptions] = await Promise.all([
    getPipelines(subdomain),
    getUsers(subdomain),
    getSourceFieldOptions(subdomain),
  ]);
  return {
    pipelines: pipelines.map(p => ({ id: p.id, name: p.name })),
    users: users.filter(u => u.rights?.is_active !== false).map(u => ({ id: u.id, name: u.name })),
    sources: sourceOptions,
  };
}

module.exports = {
  api, apiAll, getToken,
  getPipelines, getUsers, getLeads, getEvents,
  getSourceFieldOptions, buildDashboardData, getFiltersData,
};
