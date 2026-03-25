// ═══════════════════════════════════════════════════════
//  KOMMO API CLIENT — Dashboard Clínica Comercial v2
//  Multi-select filters, all leads, loss reasons
// ═══════════════════════════════════════════════════════

const axios = require('axios');
const store = require('./store');

const PAGE_LIMIT = 250;
const TZ_OFFSET = process.env.TZ_OFFSET || '-03:00';

// ─── Token helpers ───────────────────────────────────

async function refreshOAuthToken(subdomain, account) {
  try {
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
    console.log(`Token Kommo renovado com sucesso para ${subdomain}`);
    return data.access_token;
  } catch (err) {
    const status = err.response?.status;
    console.error(`Falha ao renovar token Kommo para ${subdomain}: ${status || err.message}`);
    throw new Error(
      `Falha ao renovar token Kommo (${status || err.message}). ` +
      `Reconecte a conta em /auth/connect?subdomain=${subdomain}`
    );
  }
}

async function getToken(subdomain, forceRefresh = false) {
  const acct = store.getAccount(subdomain);
  if (!acct) throw new Error(`Conta "${subdomain}" não encontrada.`);
  if (acct.auth_mode === 'long_lived') return acct.long_lived_token;
  const now = Math.floor(Date.now() / 1000);
  if (forceRefresh || acct.expires_at - now < 300) return refreshOAuthToken(subdomain, acct);
  return acct.access_token;
}

// ─── HTTP helpers ────────────────────────────────────

async function api(subdomain, method, path, params = {}, body = null) {
  const token = await getToken(subdomain);
  const url   = `https://${subdomain}.kommo.com${path}`;
  try {
    const res = await axios({ method, url, headers: { Authorization: `Bearer ${token}` }, params, data: body });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      console.log(`Kommo retornou ${status} em ${path}, tentando refresh do token...`);
      const newToken = await getToken(subdomain, true);
      const res = await axios({ method, url, headers: { Authorization: `Bearer ${newToken}` }, params, data: body });
      return res.data;
    }
    throw err;
  }
}

async function apiAll(subdomain, path, params = {}, embeddedKey) {
  let page = 1, all = [];
  while (true) {
    try {
      const res = await api(subdomain, 'GET', path, { ...params, limit: PAGE_LIMIT, page });
      const items = res?._embedded?.[embeddedKey] || [];
      if (!items.length) break;
      all = all.concat(items);
      if (items.length < PAGE_LIMIT) break;
      page++;
      if (page % 5 === 0) await sleep(300);
    } catch (err) {
      if (err.response?.status === 204) break;
      throw err;
    }
  }
  return all;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  return res?._embedded?.pipelines || [];
}

async function getUsers(subdomain) {
  return apiAll(subdomain, '/api/v4/users', {}, 'users');
}

async function getLossReasons(subdomain) {
  try {
    const res = await api(subdomain, 'GET', '/api/v4/leads/loss_reasons');
    return res?._embedded?.loss_reasons || [];
  } catch { return []; }
}

// Auto-detect "Fonte do lead" field or use env var fallback
let _sourceFieldCache = {}; // { subdomain: { id, enums } }

async function detectSourceField(subdomain) {
  if (_sourceFieldCache[subdomain]) return _sourceFieldCache[subdomain];

  // If env var is set, use it directly
  const envId = process.env.KOMMO_SOURCE_FIELD_ID;
  if (envId) {
    try {
      const res = await api(subdomain, 'GET', `/api/v4/leads/custom_fields/${envId}`);
      const result = {
        id: Number(envId),
        name: res?.name || 'Origem',
        enums: (res?.enums || []).map(e => ({ enum_id: e.id, label: e.value })),
      };
      _sourceFieldCache[subdomain] = result;
      console.log(`📌 Source field from env: "${result.name}" (ID ${result.id})`);
      return result;
    } catch { /* fall through to auto-detect */ }
  }

  // Auto-detect: fetch all lead custom fields, find "Fonte do lead" or "Fonte" or "Origem"
  try {
    const allFields = await apiAll(subdomain, '/api/v4/leads/custom_fields', {}, 'custom_fields');
    const keywords = ['fonte do lead', 'fonte', 'origem do lead', 'origem', 'source'];
    let sourceField = null;
    for (const kw of keywords) {
      sourceField = allFields.find(f => f.name && f.name.toLowerCase().trim() === kw);
      if (sourceField) break;
    }
    // Partial match fallback
    if (!sourceField) {
      sourceField = allFields.find(f => f.name && (
        f.name.toLowerCase().includes('fonte') || f.name.toLowerCase().includes('origem')
      ));
    }
    if (sourceField) {
      const result = {
        id: sourceField.id,
        name: sourceField.name,
        enums: (sourceField.enums || []).map(e => ({ enum_id: e.id, label: e.value })),
      };
      _sourceFieldCache[subdomain] = result;
      console.log(`🔍 Auto-detected source field: "${result.name}" (ID ${result.id}) with ${result.enums.length} values`);
      return result;
    }
  } catch (err) {
    console.error('Error detecting source field:', err.message);
  }

  console.log('⚠️ No source field found');
  _sourceFieldCache[subdomain] = null;
  return null;
}

async function getSourceFieldOptions(subdomain) {
  const field = await detectSourceField(subdomain);
  return field ? field.enums : [];
}

async function getSourceFieldId(subdomain) {
  const field = await detectSourceField(subdomain);
  return field ? field.id : null;
}

// ─── Fetch ALL leads with API-level filters ──────────

async function fetchAllLeads(subdomain, options = {}) {
  const { date_from, date_to, date_mode, pipeline_ids, user_ids } = options;

  const params = { with: 'custom_fields_values,loss_reason,source' };

  // Date filter on API
  const dateField = date_mode === 'closed_at' ? 'closed_at' : 'created_at';
  if (date_from) params[`filter[${dateField}][from]`] = toTimestamp(date_from);
  if (date_to)   params[`filter[${dateField}][to]`]   = toTimestampEnd(date_to);

  // Pipeline — API supports single pipeline_id only
  if (pipeline_ids && pipeline_ids.length === 1) {
    params['filter[pipeline_id]'] = pipeline_ids[0];
  }

  // Users — multiple via indexed params
  if (user_ids && user_ids.length > 0) {
    user_ids.forEach((uid, i) => {
      params[`filter[responsible_user_id][${i}]`] = uid;
    });
  }

  console.log(`📥 Fetching leads (filter by ${dateField})...`);
  let leads = await apiAll(subdomain, '/api/v4/leads', params, 'leads');
  console.log(`📥 Got ${leads.length} leads from API`);

  // In-memory: multi-pipeline filter
  if (pipeline_ids && pipeline_ids.length > 1) {
    const pSet = new Set(pipeline_ids.map(Number));
    leads = leads.filter(l => pSet.has(l.pipeline_id));
    console.log(`📥 After pipeline filter: ${leads.length}`);
  }

  return leads;
}

// ─── Build dashboard data ────────────────────────────

async function buildDashboardData(subdomain, options = {}) {
  const {
    date_from, date_to, date_mode,
    pipeline_ids, status_ids, user_ids,
    source_field_value,
  } = options;

  const [allPipelines, users, lossReasons, allLeads, sourceFieldId] = await Promise.all([
    getPipelines(subdomain),
    getUsers(subdomain),
    getLossReasons(subdomain),
    fetchAllLeads(subdomain, { date_from, date_to, date_mode, pipeline_ids, user_ids }),
    getSourceFieldId(subdomain),
  ]);

  const hasSourceField = !!sourceFieldId;

  const getCF = (lead, fid) => {
    const cf = (lead.custom_fields_values || []).find(f => f.field_id === fid);
    return cf?.values?.[0]?.value || null;
  };

  // In-memory filters
  let leads = allLeads;

  // Status multi-select
  if (status_ids && status_ids.length > 0) {
    const sSet = new Set(status_ids.map(Number));
    leads = leads.filter(l => sSet.has(l.status_id));
  }

  // Source
  if (source_field_value && hasSourceField) {
    leads = leads.filter(l => getCF(l, sourceFieldId) === source_field_value);
  }

  // Maps
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  const pipelineMap = {};
  const statusMap = {};
  allPipelines.filter(p => !p.is_archive).forEach(p => {
    pipelineMap[p.id] = p.name;
    (p._embedded?.statuses || []).forEach(s => {
      statusMap[`${p.id}-${s.id}`] = {
        name: s.name, color: s.color, sort: s.sort,
        pipeline: p.name, pipeline_id: p.id, status_id: s.id,
      };
    });
  });

  const lossReasonMap = {};
  lossReasons.forEach(r => { lossReasonMap[r.id] = r.name; });

  // ─── Aggregate ─────────────────────────────────────
  const WON_ID = 142, LOST_ID = 143;
  let totalRevenue = 0, wonCount = 0, lostCount = 0, activeCount = 0;
  let totalCycleDays = 0, cycleCount = 0;
  const byUser = {}, bySource = {}, byStatus = {}, byPipeline = {};
  const byMonth = {}, byLossReason = {};
  const wonLeads = [];

  leads.forEach(lead => {
    const isWon  = lead.status_id === WON_ID;
    const isLost = lead.status_id === LOST_ID;
    const price  = lead.price || 0;
    const userId = lead.responsible_user_id;
    const userName = userMap[userId] || `User ${userId}`;
    const pKey = lead.pipeline_id;
    const sKey = `${pKey}-${lead.status_id}`;
    const sInfo = statusMap[sKey] || { name: 'Desconhecido', color: '666', sort: 999, pipeline: '', pipeline_id: pKey, status_id: lead.status_id };
    const source = sourceFieldId ? (getCF(lead, sourceFieldId) || 'Sem origem') : 'N/A';

    if (isWon) {
      wonCount++; totalRevenue += price;
      if (lead.closed_at && lead.created_at) {
        totalCycleDays += (lead.closed_at - lead.created_at) / 86400;
        cycleCount++;
      }
      wonLeads.push({
        id: lead.id, name: lead.name, price,
        responsible: userName, created_at: lead.created_at,
        closed_at: lead.closed_at, source,
        pipeline: pipelineMap[pKey] || '',
      });
      const d = new Date((lead.closed_at || lead.created_at) * 1000);
      const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      byMonth[mk] = (byMonth[mk] || 0) + price;
    } else if (isLost) {
      lostCount++;
      // Loss reason — check _embedded.loss_reason or loss_reason_id
      let lrName = 'Sem motivo';
      if (lead._embedded?.loss_reason && lead._embedded.loss_reason.length > 0) {
        lrName = lead._embedded.loss_reason[0].name || lrName;
      } else if (lead.loss_reason_id && lossReasonMap[lead.loss_reason_id]) {
        lrName = lossReasonMap[lead.loss_reason_id];
      }
      byLossReason[lrName] = (byLossReason[lrName] || 0) + 1;
    } else {
      activeCount++;
    }

    // By user
    if (!byUser[userId]) byUser[userId] = { name: userName, id: userId, won:0, lost:0, active:0, revenue:0, count:0 };
    byUser[userId].count++;
    if (isWon)  { byUser[userId].won++; byUser[userId].revenue += price; }
    if (isLost) byUser[userId].lost++;
    if (!isWon && !isLost) byUser[userId].active++;

    // By source
    if (!bySource[source]) bySource[source] = { won:0, lost:0, active:0, revenue:0, count:0 };
    bySource[source].count++;
    if (isWon)  { bySource[source].won++; bySource[source].revenue += price; }
    if (isLost) bySource[source].lost++;
    if (!isWon && !isLost) bySource[source].active++;

    // By status
    if (!byStatus[sKey]) byStatus[sKey] = { ...sInfo, count:0, value:0 };
    byStatus[sKey].count++; byStatus[sKey].value += price;

    // By pipeline
    if (!byPipeline[pKey]) byPipeline[pKey] = { name: pipelineMap[pKey]||`Pipeline ${pKey}`, id:pKey, count:0, revenue:0, won:0, lost:0, active:0 };
    byPipeline[pKey].count++;
    if (isWon)  { byPipeline[pKey].won++; byPipeline[pKey].revenue += price; }
    if (isLost) byPipeline[pKey].lost++;
    if (!isWon && !isLost) byPipeline[pKey].active++;
  });

  const totalLeads = leads.length;

  return {
    kpis: {
      total_leads:     totalLeads,
      active_leads:    activeCount,
      won:             wonCount,
      lost:            lostCount,
      revenue:         totalRevenue,
      conv_rate:       totalLeads > 0 ? Math.round((wonCount/totalLeads)*1000)/10 : 0,
      conv_opp_to_won: (wonCount+lostCount) > 0 ? Math.round((wonCount/(wonCount+lostCount))*1000)/10 : 0,
      avg_cycle_days:  cycleCount > 0 ? Math.round((totalCycleDays/cycleCount)*10)/10 : 0,
      avg_ticket:      wonCount > 0 ? Math.round(totalRevenue/wonCount) : 0,
    },
    user_ranking:      Object.values(byUser).sort((a,b) => b.revenue - a.revenue).slice(0,30),
    source_breakdown:  Object.entries(bySource).map(([name,d]) => ({ name, ...d, conversion: d.count>0 ? Math.round((d.won/d.count)*1000)/10 : 0 })).sort((a,b) => b.count - a.count),
    funnel:            Object.values(byStatus).sort((a,b) => { if (a.pipeline_id!==b.pipeline_id) return (a.pipeline_id||0)-(b.pipeline_id||0); return (a.sort||0)-(b.sort||0); }),
    monthly_revenue:   Object.entries(byMonth).sort(([a],[b]) => a.localeCompare(b)).map(([month,revenue]) => ({ month, revenue })),
    won_leads:         wonLeads.sort((a,b) => (b.closed_at||0)-(a.closed_at||0)).slice(0,100),
    loss_reasons:      Object.entries(byLossReason).map(([name,count]) => ({ name, count })).sort((a,b) => b.count-a.count),
    pipelines_summary: Object.values(byPipeline),
  };
}

// ─── Filters data ────────────────────────────────────

async function getFiltersData(subdomain) {
  const [allPipelines, users, sourceField] = await Promise.all([
    getPipelines(subdomain),
    getUsers(subdomain),
    detectSourceField(subdomain),
  ]);

  const pipelines = allPipelines.filter(p => !p.is_archive).map(p => ({
    id: p.id,
    name: p.name,
    statuses: (p._embedded?.statuses || [])
      .sort((a,b) => a.sort - b.sort)
      .map(s => ({ id: s.id, name: s.name, color: s.color })),
  }));

  return {
    pipelines,
    users: users.filter(u => u.rights?.is_active !== false).map(u => ({ id: u.id, name: u.name })),
    sources: sourceField ? sourceField.enums : [],
    source_field_name: sourceField ? sourceField.name : null,
  };
}

// ═══════════════════════════════════════════════════════
//  SLA / RESPONSE TIME — Chat messages only
//  Pairs incoming_chat_message → outgoing_chat_message
//  Tracks responsible via entity_responsible_changed
// ═══════════════════════════════════════════════════════

// ─── Business hours helpers ──────────────────────────

function parseHHMM(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function parseTzOffsetMs(tz) {
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return -3 * 3600000; // default -03:00
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number(m[2]) * 3600000 + Number(m[3]) * 60000);
}

/**
 * Convert a unix timestamp to local "minutes from midnight" given tz offset.
 */
function tsToLocalMinutes(ts, offsetMs) {
  const d = new Date(ts * 1000 + offsetMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function tsToLocalDow(ts, offsetMs) {
  return new Date(ts * 1000 + offsetMs).getUTCDay(); // 0=Sun
}

/**
 * Adjust a timestamp to the next business-hour start if it's outside hours.
 * Returns adjusted unix timestamp (seconds).
 */
function adjustToBizHours(ts, bh, offsetMs) {
  const workDays = new Set(bh.work_days.split(',').map(Number));
  const bhStart = parseHHMM(bh.start_time);
  const bhEnd   = parseHHMM(bh.end_time);

  let d = new Date(ts * 1000 + offsetMs);
  let localMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  let dow = d.getUTCDay();

  // If before business start or not a work day → snap to next biz start
  // If after business end → snap to next day's biz start
  for (let safety = 0; safety < 14; safety++) {
    if (workDays.has(dow) && localMin >= bhStart && localMin < bhEnd) {
      // Already within business hours
      return Math.floor((d.getTime() - offsetMs) / 1000);
    }
    if (workDays.has(dow) && localMin < bhStart) {
      // Same day, snap to start
      d.setUTCHours(Math.floor(bhStart / 60), bhStart % 60, 0, 0);
      return Math.floor((d.getTime() - offsetMs) / 1000);
    }
    // Move to next day start
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(Math.floor(bhStart / 60), bhStart % 60, 0, 0);
    localMin = bhStart;
    dow = d.getUTCDay();
  }
  return ts; // fallback
}

/**
 * Count business minutes between two timestamps.
 * Both timestamps are adjusted to business hours first.
 */
function businessMinutes(startTs, endTs, bh, offsetMs) {
  if (endTs <= startTs) return 0;

  const workDays = new Set(bh.work_days.split(',').map(Number));
  const bhStart  = parseHHMM(bh.start_time);
  const bhEnd    = parseHHMM(bh.end_time);
  const bhLen    = bhEnd - bhStart;
  if (bhLen <= 0) return 0;

  // Adjust both to biz hours
  const adjStart = adjustToBizHours(startTs, bh, offsetMs);
  const adjEnd   = adjustToBizHours(endTs, bh, offsetMs);
  if (adjEnd <= adjStart) return 0;

  const dStart = new Date(adjStart * 1000 + offsetMs);
  const dEnd   = new Date(adjEnd * 1000 + offsetMs);

  let total = 0;
  const cursor = new Date(dStart);
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor <= dEnd) {
    const dow = cursor.getUTCDay();
    if (workDays.has(dow)) {
      const dayMs     = cursor.getTime();
      const bhStartMs = dayMs + bhStart * 60000;
      const bhEndMs   = dayMs + bhEnd * 60000;
      const oStart    = Math.max(dStart.getTime(), bhStartMs);
      const oEnd      = Math.min(dEnd.getTime(), bhEndMs);
      if (oEnd > oStart) total += (oEnd - oStart) / 60000;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return Math.round(total * 100) / 100;
}

// ─── Percentile helper ───────────────────────────────

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Fetch chat events + responsible changes ─────────
// IMPORTANT: Chat events in Kommo can have entity_type='contact' or 'lead'.
// We fetch ALL chat events (no entity filter) and map contacts→leads later.

async function fetchChatAndResponsibleEvents(subdomain, dateFrom, dateTo) {
  // Chat messages (NO entity filter — events may be on contacts)
  const chatParams = {
    'filter[type][0]': 'incoming_chat_message',
    'filter[type][1]': 'outgoing_chat_message',
  };
  if (dateFrom) chatParams['filter[created_at][from]'] = dateFrom;
  if (dateTo)   chatParams['filter[created_at][to]']   = dateTo;

  // Talk lifecycle: talk_created (entity_type=contact, gives us talk_id)
  //                 talk_closed (entity_type=talk, entity_id=talk_id)
  //                 conversation_answered (entity_type varies)
  const talkParams = {
    'filter[type][0]': 'talk_created',
    'filter[type][1]': 'talk_closed',
    'filter[type][2]': 'conversation_answered',
  };
  // Use a wider date range for talk events:
  // - date_from: go back 180 days before the requested range to capture talk_created events
  // - date_to: omit (fetch up to now) so we catch close events after the message range
  if (dateFrom) {
    const widerFrom = dateFrom - (180 * 24 * 60 * 60); // 180 days before
    talkParams['filter[created_at][from]'] = widerFrom;
  }

  // Responsible changes
  const respParams = {
    'filter[type][0]': 'entity_responsible_changed',
  };
  if (dateFrom) respParams['filter[created_at][from]'] = dateFrom;
  if (dateTo)   respParams['filter[created_at][to]']   = dateTo;

  console.log('📨 Fetching chat + talk lifecycle + responsible events...');
  const [chatEvents, talkEvents, respEvents] = await Promise.all([
    apiAll(subdomain, '/api/v4/events', chatParams, 'events'),
    apiAll(subdomain, '/api/v4/events', talkParams, 'events'),
    apiAll(subdomain, '/api/v4/events', respParams, 'events'),
  ]);

  const incoming = chatEvents.filter(e => e.type === 'incoming_chat_message').length;
  const outgoing = chatEvents.filter(e => e.type === 'outgoing_chat_message').length;
  const talkCreated = talkEvents.filter(e => e.type === 'talk_created').length;
  const talkClosed  = talkEvents.filter(e => e.type === 'talk_closed').length;
  const answered    = talkEvents.filter(e => e.type === 'conversation_answered').length;
  console.log(`📨 Chat: ${incoming} in, ${outgoing} out | Talk: ${talkCreated} created, ${talkClosed} closed, ${answered} answered | ${respEvents.length} resp_changes`);

  return { chatEvents, talkEvents, respEvents };
}

/**
 * Check if a unix timestamp falls within business hours.
 */
function isWithinBusinessHours(ts, bh, offsetMs) {
  const workDays = new Set(bh.work_days.split(',').map(Number));
  const bhStart  = parseHHMM(bh.start_time);
  const bhEnd    = parseHHMM(bh.end_time);
  const d = new Date(ts * 1000 + offsetMs);
  const dow = d.getUTCDay();
  if (!workDays.has(dow)) return false;
  const localMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return localMin >= bhStart && localMin < bhEnd;
}

// ─── Build SLA data ──────────────────────────────────

async function buildSLAData(subdomain, options = {}) {
  const {
    date_from, date_to, date_mode,
    pipeline_ids, user_ids,
    business_hours,
  } = options;

  const offsetMs = parseTzOffsetMs(TZ_OFFSET);
  const bh = business_hours || { work_days: '1,2,3,4,5', start_time: '08:00', end_time: '18:00', sla_target_minutes: 10 };
  const slaTarget = bh.sla_target_minutes || 10;

  const tsFrom = date_from ? toTimestamp(date_from) : undefined;
  const tsTo   = date_to   ? toTimestampEnd(date_to) : undefined;

  const [allLeads, { chatEvents, talkEvents, respEvents }, users] = await Promise.all([
    // Fetch leads WITH contacts embedded for contact→lead mapping
    (async () => {
      const p = { with: 'contacts' };
      const df = (date_mode === 'closed_at') ? 'closed_at' : 'created_at';
      if (tsFrom) p[`filter[${df}][from]`] = tsFrom;
      if (tsTo)   p[`filter[${df}][to]`]   = tsTo;
      if (pipeline_ids && pipeline_ids.length === 1) p['filter[pipeline_id]'] = pipeline_ids[0];
      if (user_ids && user_ids.length > 0) user_ids.forEach((uid, i) => { p[`filter[responsible_user_id][${i}]`] = uid; });
      let leads = await apiAll(subdomain, '/api/v4/leads', p, 'leads');
      if (pipeline_ids && pipeline_ids.length > 1) {
        const pSet = new Set(pipeline_ids.map(Number));
        leads = leads.filter(l => pSet.has(l.pipeline_id));
      }
      return leads;
    })(),
    fetchChatAndResponsibleEvents(subdomain, tsFrom, tsTo),
    getUsers(subdomain),
  ]);

  console.log(`📊 SLA: ${allLeads.length} leads, ${chatEvents.length} chat events`);

  const leadIds = new Set(allLeads.map(l => l.id));
  const leadMap = {};
  allLeads.forEach(l => { leadMap[l.id] = l; });

  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  // Build contact → lead mapping (chat events often have entity_type='contact')
  const contactToLead = {};
  allLeads.forEach(lead => {
    const contacts = lead._embedded?.contacts || [];
    contacts.forEach(c => {
      if (!contactToLead[c.id]) contactToLead[c.id] = lead.id;
    });
  });
  console.log(`📊 Contact→Lead map: ${Object.keys(contactToLead).length} contacts`);

  // Resolve event to lead_id (accepts both entity_type='lead' and 'contact')
  function resolveLeadId(event) {
    if (event.entity_type === 'lead' && leadIds.has(event.entity_id)) return event.entity_id;
    if (event.entity_type === 'contact') {
      const lid = contactToLead[event.entity_id];
      if (lid && leadIds.has(lid)) return lid;
    }
    return null;
  }

  // Build responsible timeline per lead from respEvents
  // { leadId: [ { ts, userId } ] } sorted by ts asc
  const respTimeline = {};
  respEvents
    .filter(e => e.entity_type === 'lead' && leadIds.has(e.entity_id))
    .forEach(e => {
      if (!respTimeline[e.entity_id]) respTimeline[e.entity_id] = [];
      // value_after[0].responsible_user.id
      const afterUser = e.value_after?.[0]?.responsible_user?.id;
      if (afterUser) {
        respTimeline[e.entity_id].push({ ts: e.created_at, userId: afterUser });
      }
    });
  for (const leadId of Object.keys(respTimeline)) {
    respTimeline[leadId].sort((a, b) => a.ts - b.ts);
  }

  /**
   * Get the responsible user for a lead at a given timestamp.
   * Walk the timeline backwards; if no change found, use lead's current responsible.
   */
  function getResponsibleAt(leadId, ts) {
    const timeline = respTimeline[leadId];
    if (timeline && timeline.length > 0) {
      // Find the last change at or before ts
      let userId = null;
      for (const entry of timeline) {
        if (entry.ts <= ts) userId = entry.userId;
        else break;
      }
      if (userId) return userId;
    }
    // Fallback: current responsible on lead
    return leadMap[leadId]?.responsible_user_id;
  }

  // Group chat/message events by resolved lead (only incoming + outgoing)
  // ALSO build a reverse map: any entity_id that mapped → lead_id
  const chatByLead = {};
  let mapped = 0, unmapped = 0;
  chatEvents.forEach(e => {
    if (e.type !== 'incoming_chat_message' && e.type !== 'outgoing_chat_message') return;
    const lid = resolveLeadId(e);
    if (lid) {
      if (!chatByLead[lid]) chatByLead[lid] = [];
      chatByLead[lid].push(e);
      mapped++;
    } else {
      unmapped++;
    }
  });
  console.log(`📊 Chat msg events → leads: ${mapped} mapped, ${unmapped} unmapped, ${Object.keys(chatByLead).length} leads with chats`);

  // ═══════════════════════════════════════════════════════
  // CLOSE DETECTION — Multi-strategy approach
  //
  // Strategy 1: Direct resolution (entity_type='lead' or 'contact')
  // Strategy 2: Chain: talk_created → talk_id → talk_closed
  // Strategy 3: API fallback: GET /api/v4/talks/{id} for unresolved talk_ids
  // ═══════════════════════════════════════════════════════

  const closedTypes = new Set(['talk_closed', 'conversation_answered']);

  // Collect all close events and their timestamps
  const closeEvents = talkEvents.filter(e => closedTypes.has(e.type));

  // ── Strategy 1 + 2 prep: Build chain from talk_created events ──
  const contactTalks = {}; // contact_id → [{ talk_id, created_at }]

  talkEvents.filter(e => e.type === 'talk_created').forEach(e => {
    const contactId = e.entity_id;
    // Try multiple paths to extract talk_id
    let talkId = null;
    if (e.value_after?.[0]?.talk?.id)        talkId = e.value_after[0].talk.id;
    else if (e.value_after?.[0]?.note?.id)    talkId = e.value_after[0].note.id;
    else if (e.value_after?.[0]?.id)          talkId = e.value_after[0].id;
    else if (e.value_after?.talk?.id)          talkId = e.value_after.talk.id;
    else if (e.value_after?.id)                talkId = e.value_after.id;
    if (!contactTalks[contactId]) contactTalks[contactId] = [];
    contactTalks[contactId].push({ talk_id: talkId, created_at: e.created_at });
  });

  // Reverse: talk_id → contact_id
  const talkToContact = {};
  for (const [contactId, talks] of Object.entries(contactTalks)) {
    for (const t of talks) {
      if (t.talk_id) talkToContact[t.talk_id] = Number(contactId);
    }
  }

  // ── Resolve close events to leads (strategies 1 + 2) ──
  let closeEventsInjected = 0;
  const unresolvedTalkCloseEvents = []; // events with entity_type='talk' that couldn't be resolved

  closeEvents.forEach(e => {
    let lid = null;

    if (e.entity_type === 'lead' && leadIds.has(e.entity_id)) {
      lid = e.entity_id;
    } else if (e.entity_type === 'contact') {
      lid = contactToLead[e.entity_id] || null;
    } else if (e.entity_type === 'talk') {
      const cid = talkToContact[e.entity_id];
      if (cid) lid = contactToLead[cid] || null;
      if (!lid) {
        unresolvedTalkCloseEvents.push(e);
        return; // Will try strategy 3
      }
    }

    if (lid && leadIds.has(lid)) {
      if (!chatByLead[lid]) chatByLead[lid] = [];
      chatByLead[lid].push({ type: e.type, created_at: e.created_at, entity_type: e.entity_type, entity_id: e.entity_id });
      closeEventsInjected++;
    }
  });

  console.log(`📊 Close detection: ${closeEventsInjected} resolved via chain, ${unresolvedTalkCloseEvents.length} unresolved talk events → trying API fallback`);

  // ── Strategy 3: API fallback for unresolved talk_ids ──
  // Fetch each talk from /api/v4/talks/{id} to get its entity (contact/lead)
  if (unresolvedTalkCloseEvents.length > 0) {
    const uniqueTalkIds = [...new Set(unresolvedTalkCloseEvents.map(e => e.entity_id))];
    console.log(`📊 Fetching ${uniqueTalkIds.length} talks from API for resolution...`);

    const talkToLeadFromAPI = {}; // talk_id → lead_id

    // Batch fetch talks, 10 at a time to avoid rate limits
    for (let i = 0; i < uniqueTalkIds.length; i += 10) {
      const batch = uniqueTalkIds.slice(i, i + 10);
      const promises = batch.map(talkId =>
        api(subdomain, 'GET', `/api/v4/talks/${talkId}`)
          .then(data => ({ talkId, data }))
          .catch(() => ({ talkId, data: null }))
      );
      const results = await Promise.all(promises);

      for (const { talkId, data } of results) {
        if (!data) continue;

        let lid = null;
        // The talk object may have entity_id/entity_type pointing to lead or contact
        // Try multiple field paths (Kommo API varies between versions)
        const entityId   = data.entity_id;
        const entityType = data.entity_type;
        const contactId  = data.contact_id;

        if (entityType === 'leads' || entityType === 'lead') {
          if (leadIds.has(entityId)) lid = entityId;
        }
        if (!lid && contactId) {
          lid = contactToLead[contactId] || null;
        }
        if (!lid && (entityType === 'contacts' || entityType === 'contact')) {
          lid = contactToLead[entityId] || null;
        }

        // Also check _embedded.contacts or _embedded.leads
        if (!lid && data._embedded?.leads?.length) {
          const embeddedLead = data._embedded.leads.find(l => leadIds.has(l.id));
          if (embeddedLead) lid = embeddedLead.id;
        }
        if (!lid && data._embedded?.contacts?.length) {
          for (const c of data._embedded.contacts) {
            const mappedLid = contactToLead[c.id];
            if (mappedLid && leadIds.has(mappedLid)) { lid = mappedLid; break; }
          }
        }

        if (lid) talkToLeadFromAPI[talkId] = lid;
      }

      if (i + 10 < uniqueTalkIds.length) await sleep(200);
    }

    // Now inject the resolved events
    let apiResolved = 0;
    unresolvedTalkCloseEvents.forEach(e => {
      const lid = talkToLeadFromAPI[e.entity_id];
      if (lid && leadIds.has(lid)) {
        if (!chatByLead[lid]) chatByLead[lid] = [];
        chatByLead[lid].push({ type: e.type, created_at: e.created_at, entity_type: e.entity_type, entity_id: e.entity_id });
        apiResolved++;
        closeEventsInjected++;
      }
    });
    console.log(`📊 API fallback resolved: ${apiResolved}/${unresolvedTalkCloseEvents.length} talk close events`);
  }

  console.log(`📊 Total close events injected into lead timelines: ${closeEventsInjected}`);

  // ── Build lead → latestCloseTimestamp function (uses injected events) ──

  function getLeadLatestClose(leadId) {
    // Since close events are now injected into chatByLead,
    // we can check the timeline directly
    const evts = chatByLead[leadId] || [];
    let latestClose = 0;
    evts.forEach(e => {
      if (closedTypes.has(e.type)) {
        latestClose = Math.max(latestClose, e.created_at);
      }
    });
    return latestClose;
  }

  // Per-user aggregation
  const userSLA = {};
  const pendingLeads = [];
  const now = Math.floor(Date.now() / 1000);

  function ensureUser(userId) {
    if (!userSLA[userId]) {
      userSLA[userId] = {
        id: userId,
        name: userMap[userId] || `User ${userId}`,
        response_times: [],
        within_sla: 0,
        outside_sla: 0,
        leads_set: new Set(),
      };
    }
  }

  // ─── PHASE 1: Walk chat timelines, pair incoming→outgoing ─
  // Timeline now includes: incoming_chat_message, outgoing_chat_message,
  // talk_closed, conversation_answered.
  // Collect pending leads (lastIncoming without outgoing/close after).

  const pendingCandidates = []; // { leadId, lastIncoming, responsibleId }
  let closedInlineCount = 0;

  for (const [leadIdStr, evts] of Object.entries(chatByLead)) {
    const leadId = Number(leadIdStr);
    const lead = leadMap[leadId];
    if (!lead) continue;

    evts.sort((a, b) => a.created_at - b.created_at);
    let lastIncoming = null;

    for (const evt of evts) {
      const isIncoming = evt.type === 'incoming_chat_message';
      const isOutgoing = evt.type === 'outgoing_chat_message';
      const isClose    = evt.type === 'talk_closed' || evt.type === 'conversation_answered';

      if (isIncoming) {
        if (!isWithinBusinessHours(evt.created_at, bh, offsetMs)) continue;
        if (!lastIncoming) lastIncoming = evt;
      } else if (isOutgoing && lastIncoming) {
        // Valid pair: incoming → outgoing
        const responsibleId = getResponsibleAt(leadId, lastIncoming.created_at);
        ensureUser(responsibleId);
        const respMin = businessMinutes(lastIncoming.created_at, evt.created_at, bh, offsetMs);
        userSLA[responsibleId].response_times.push(respMin);
        userSLA[responsibleId].leads_set.add(leadId);
        if (respMin <= slaTarget) {
          userSLA[responsibleId].within_sla++;
        } else {
          userSLA[responsibleId].outside_sla++;
        }
        lastIncoming = null;
      } else if (isClose && lastIncoming) {
        // Conversation finalized (talk_closed/conversation_answered) after
        // incoming message — not pending, no response time to measure
        lastIncoming = null;
        closedInlineCount++;
      }
    }

    // If there's an unanswered incoming at the end, it's a pending candidate
    if (lastIncoming) {
      const responsibleId = getResponsibleAt(leadId, lastIncoming.created_at);
      pendingCandidates.push({ leadId, lastIncoming, responsibleId });
    }
  }

  console.log(`📊 Phase 1: ${pendingCandidates.length} pending candidates, ${closedInlineCount} resolved inline by talk_closed/conversation_answered`);

  // ─── PHASE 2: Check pending candidates against close chain ─
  // For each candidate, check if the lead's conversation was closed
  // AFTER the last incoming message. Uses the contact→talk→closed chain.

  let closedByCloseEvent = 0;

  for (const candidate of pendingCandidates) {
    const { leadId, lastIncoming, responsibleId } = candidate;
    const lead = leadMap[leadId];
    const userName = userMap[responsibleId] || `User ${responsibleId}`;

    // Get the latest close timestamp for this lead
    const latestClose = getLeadLatestClose(leadId);

    // If closed AFTER the last incoming → conversation resolved → not pending
    if (latestClose > 0 && latestClose >= lastIncoming.created_at) {
      closedByCloseEvent++;
      continue;
    }

    // Still pending
    const waitBiz = businessMinutes(lastIncoming.created_at, now, bh, offsetMs);
    const waitTotal = Math.round((now - lastIncoming.created_at) / 60);

    pendingLeads.push({
      lead_id: leadId,
      lead_name: lead.name || `Lead ${leadId}`,
      responsible_id: responsibleId,
      responsible_name: userName,
      incoming_at: lastIncoming.created_at,
      waiting_minutes: Math.round(waitBiz),
      waiting_total_minutes: waitTotal,
      over_sla: waitBiz > slaTarget,
    });
  }

  console.log(`📊 Phase 2: ${closedByCloseEvent} resolved by close chain, ${pendingLeads.length} truly pending`);

  // Build per-user metrics
  const userMetrics = Object.values(userSLA).map(u => {
    const times = u.response_times;
    const total = times.length;
    const avg   = total > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / total * 10) / 10 : 0;
    const med   = total > 0 ? Math.round(percentile(times, 50) * 10) / 10 : 0;
    const p90   = total > 0 ? Math.round(percentile(times, 90) * 10) / 10 : 0;
    const slaRate = total > 0 ? Math.round((u.within_sla / total) * 1000) / 10 : 0;

    return {
      id: u.id,
      name: u.name,
      leads_count: u.leads_set.size,
      total_messages: total,
      avg_response_minutes: avg,
      median_response_minutes: med,
      p90_response_minutes: p90,
      within_sla: u.within_sla,
      outside_sla: u.outside_sla,
      sla_rate: slaRate,
    };
  }).sort((a, b) => a.avg_response_minutes - b.avg_response_minutes);

  // Filter by user_ids if specified (post-calc)
  let filteredMetrics = userMetrics;
  if (user_ids && user_ids.length > 0) {
    const uSet = new Set(user_ids.map(Number));
    filteredMetrics = userMetrics.filter(u => uSet.has(u.id));
  }

  // Pending: sort by wait desc, filter by user if needed
  let filteredPending = pendingLeads.sort((a, b) => b.waiting_minutes - a.waiting_minutes);
  if (user_ids && user_ids.length > 0) {
    const uSet = new Set(user_ids.map(Number));
    filteredPending = filteredPending.filter(p => uSet.has(p.responsible_id));
  }

  // Global
  let globalTotal = 0, globalWithin = 0, globalSum = 0;
  filteredMetrics.forEach(u => {
    globalTotal  += u.total_messages;
    globalWithin += u.within_sla;
    globalSum    += u.avg_response_minutes * u.total_messages;
  });
  const globalAvg = globalTotal > 0 ? Math.round(globalSum / globalTotal * 10) / 10 : 0;
  const globalSla = globalTotal > 0 ? Math.round((globalWithin / globalTotal) * 1000) / 10 : 0;
  const allTimes  = filteredMetrics.flatMap(u => []); // recalc from raw? We use per-user
  const globalP90 = filteredMetrics.length > 0
    ? Math.round(Math.max(...filteredMetrics.map(u => u.p90_response_minutes)) * 10) / 10
    : 0;

  return {
    sla_target_minutes: slaTarget,
    global: {
      avg_response_minutes: globalAvg,
      total_messages: globalTotal,
      sla_rate: globalSla,
      p90_minutes: globalP90,
      pending_count: filteredPending.length,
      over_sla_count: filteredPending.filter(p => p.over_sla).length,
    },
    users: filteredMetrics,
    pending_leads: filteredPending.slice(0, 200),
  };
}

// ═══════════════════════════════════════════════════════
//  DEBUG: Inspect raw events for a lead to diagnose SLA issues
// ═══════════════════════════════════════════════════════

async function debugLeadEvents(subdomain, leadId) {
  // 1. Fetch the lead with contacts
  const lead = await api(subdomain, 'GET', `/api/v4/leads/${leadId}`, { with: 'contacts' });
  const contactIds = (lead?._embedded?.contacts || []).map(c => c.id);

  // 2. Fetch ALL events for this lead (entity_type=lead)
  const leadEvents = await apiAll(subdomain, '/api/v4/events', {
    'filter[entity]': 'lead',
    'filter[entity_id][]': leadId,
  }, 'events');

  // 3. Fetch ALL events for each contact (entity_type=contact)
  let contactEvents = [];
  for (const cid of contactIds) {
    const evts = await apiAll(subdomain, '/api/v4/events', {
      'filter[entity]': 'contact',
      'filter[entity_id][]': cid,
    }, 'events');
    contactEvents = contactEvents.concat(evts.map(e => ({ ...e, _debug_for_contact: cid })));
  }

  // 4. Filter for relevant event types
  const relevantTypes = new Set([
    'incoming_chat_message', 'outgoing_chat_message',
    'talk_created', 'talk_closed', 'conversation_answered',
  ]);

  const relevantLeadEvents = leadEvents.filter(e => relevantTypes.has(e.type));
  const relevantContactEvents = contactEvents.filter(e => relevantTypes.has(e.type));

  // 5. For any talk_created events, extract talk_ids
  const talkIds = [];
  [...relevantLeadEvents, ...relevantContactEvents]
    .filter(e => e.type === 'talk_created')
    .forEach(e => {
      const paths = {
        'value_after[0].talk.id': e.value_after?.[0]?.talk?.id,
        'value_after[0].note.id': e.value_after?.[0]?.note?.id,
        'value_after[0].id': e.value_after?.[0]?.id,
        'value_after.talk.id': e.value_after?.talk?.id,
        'value_after.id': e.value_after?.id,
      };
      talkIds.push({ event_id: e.id, entity_id: e.entity_id, entity_type: e.entity_type, paths, raw_value_after: e.value_after });
    });

  // 6. For talk_closed/conversation_answered, show full structure
  const closeEventsOnLead = relevantLeadEvents.filter(e => e.type === 'talk_closed' || e.type === 'conversation_answered');
  const closeEventsOnContacts = relevantContactEvents.filter(e => e.type === 'talk_closed' || e.type === 'conversation_answered');

  // 7. Try fetching talks for this lead's contacts (if any talk_closed found)
  const allCloseEvents = [...closeEventsOnLead, ...closeEventsOnContacts];
  const talkApiResults = [];
  const closeTalkIds = [...new Set(allCloseEvents.filter(e => e.entity_type === 'talk').map(e => e.entity_id))];
  for (const tid of closeTalkIds.slice(0, 5)) {
    try {
      const talkData = await api(subdomain, 'GET', `/api/v4/talks/${tid}`);
      talkApiResults.push({ talk_id: tid, data: talkData });
    } catch (err) {
      talkApiResults.push({ talk_id: tid, error: err.message });
    }
  }

  return {
    lead: { id: lead.id, name: lead.name, responsible_user_id: lead.responsible_user_id },
    contacts: contactIds,
    lead_events_summary: relevantLeadEvents.map(e => ({
      type: e.type, entity_type: e.entity_type, entity_id: e.entity_id,
      created_at: e.created_at, date: new Date(e.created_at * 1000).toISOString(),
    })),
    contact_events_summary: relevantContactEvents.map(e => ({
      type: e.type, entity_type: e.entity_type, entity_id: e.entity_id,
      created_at: e.created_at, date: new Date(e.created_at * 1000).toISOString(),
      _for_contact: e._debug_for_contact,
    })),
    talk_created_analysis: talkIds,
    close_events_on_lead: closeEventsOnLead.map(e => ({
      type: e.type, entity_type: e.entity_type, entity_id: e.entity_id,
      created_at: e.created_at, value_after: e.value_after, value_before: e.value_before,
    })),
    close_events_on_contacts: closeEventsOnContacts.map(e => ({
      type: e.type, entity_type: e.entity_type, entity_id: e.entity_id,
      created_at: e.created_at, value_after: e.value_after, value_before: e.value_before,
    })),
    talk_api_results: talkApiResults,
  };
}

module.exports = {
  api, apiAll, getToken, getPipelines, getUsers,
  getLossReasons, getSourceFieldOptions, getSourceFieldId, detectSourceField,
  fetchAllLeads, buildDashboardData, getFiltersData,
  fetchChatAndResponsibleEvents, buildSLAData,
  debugLeadEvents,
};
