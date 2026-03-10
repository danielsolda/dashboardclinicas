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

async function api(subdomain, method, path, params = {}, body = null) {
  const token = await getToken(subdomain);
  const url   = `https://${subdomain}.kommo.com${path}`;
  const res   = await axios({ method, url, headers: { Authorization: `Bearer ${token}` }, params, data: body });
  return res.data;
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
//  SLA / RESPONSE TIME ANALYSIS
// ═══════════════════════════════════════════════════════

const INCOMING_TYPES = [
  'incoming_chat_message', 'incoming_call', 'incoming_sms', 'incoming_mail',
];
const OUTGOING_TYPES = [
  'outgoing_chat_message', 'outgoing_call', 'outgoing_sms', 'outgoing_mail',
];
const ALL_MSG_TYPES = [...INCOMING_TYPES, ...OUTGOING_TYPES];

// ─── Business hours calculation ──────────────────────

function parseTime(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Calculate minutes between two timestamps, counting only business hours.
 * @param {number} startTs - Unix timestamp (seconds)
 * @param {number} endTs   - Unix timestamp (seconds)
 * @param {object} bh      - { work_days: '1,2,3,4,5', start_time: '08:00', end_time: '18:00' }
 * @param {string} tzOffset - e.g. '-03:00'
 */
function businessMinutes(startTs, endTs, bh, tzOffset) {
  if (endTs <= startTs) return 0;

  const workDays = new Set(bh.work_days.split(',').map(Number));
  const bhStart  = parseTime(bh.start_time); // minutes from midnight
  const bhEnd    = parseTime(bh.end_time);
  const bhLength = bhEnd - bhStart; // business minutes per day
  if (bhLength <= 0) return 0;

  // Convert to Date objects with timezone offset
  const offsetMs = parseTimezoneOffset(tzOffset);
  const dStart = new Date(startTs * 1000 + offsetMs);
  const dEnd   = new Date(endTs * 1000 + offsetMs);

  let totalMinutes = 0;

  // Iterate day by day
  const cursor = new Date(dStart);
  cursor.setUTCHours(0, 0, 0, 0); // start of day

  while (cursor <= dEnd) {
    const dow = cursor.getUTCDay(); // 0=Sun, 1=Mon, ...
    if (workDays.has(dow)) {
      const dayStartMs = cursor.getTime();
      const bhStartMs  = dayStartMs + bhStart * 60000;
      const bhEndMs    = dayStartMs + bhEnd * 60000;

      // Overlap of [startTs, endTs] with [bhStartMs, bhEndMs]
      const overlapStart = Math.max(dStart.getTime(), bhStartMs);
      const overlapEnd   = Math.min(dEnd.getTime(), bhEndMs);

      if (overlapEnd > overlapStart) {
        totalMinutes += (overlapEnd - overlapStart) / 60000;
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return Math.round(totalMinutes * 10) / 10;
}

function parseTimezoneOffset(tz) {
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number(m[2]) * 3600000 + Number(m[3]) * 60000);
}

// ─── Fetch message events ────────────────────────────

async function fetchMessageEvents(subdomain, dateFrom, dateTo) {
  const params = {};
  ALL_MSG_TYPES.forEach((t, i) => {
    params[`filter[type][${i}]`] = t;
  });
  if (dateFrom) params['filter[created_at][from]'] = dateFrom;
  if (dateTo)   params['filter[created_at][to]']   = dateTo;
  params['filter[entity]'] = 'lead';

  console.log('📨 Fetching message events...');
  const events = await apiAll(subdomain, '/api/v4/events', params, 'events');
  console.log(`📨 Got ${events.length} message events`);
  return events;
}

// ─── Build SLA data ──────────────────────────────────

async function buildSLAData(subdomain, options = {}) {
  const {
    date_from, date_to, date_mode,
    pipeline_ids, user_ids,
    business_hours,
  } = options;

  const tzOffset = TZ_OFFSET;
  const bh = business_hours || { work_days: '1,2,3,4,5', start_time: '08:00', end_time: '18:00', sla_target_minutes: 30 };
  const slaTarget = bh.sla_target_minutes || 30;

  // Fetch leads (same filters as dashboard) + events in parallel
  const tsFrom = date_from ? toTimestamp(date_from) : undefined;
  const tsTo   = date_to   ? toTimestampEnd(date_to) : undefined;

  const [allLeads, events, users] = await Promise.all([
    fetchAllLeads(subdomain, { date_from, date_to, date_mode: date_mode || 'created_at', pipeline_ids, user_ids }),
    fetchMessageEvents(subdomain, tsFrom, tsTo),
    getUsers(subdomain),
  ]);

  // Filter leads by pipeline in-memory if needed
  const leadIds = new Set(allLeads.map(l => l.id));
  const leadMap = {};
  allLeads.forEach(l => { leadMap[l.id] = l; });

  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  // Filter events to only those belonging to filtered leads
  const leadEvents = events.filter(e => e.entity_type === 'lead' && leadIds.has(e.entity_id));

  // Group events by lead
  const eventsByLead = {};
  leadEvents.forEach(e => {
    if (!eventsByLead[e.entity_id]) eventsByLead[e.entity_id] = [];
    eventsByLead[e.entity_id].push(e);
  });

  // Per-user aggregation
  const userSLA = {};
  // Pending leads (incoming without response)
  const pendingLeads = [];
  const now = Math.floor(Date.now() / 1000);

  for (const [leadIdStr, evts] of Object.entries(eventsByLead)) {
    const leadId = Number(leadIdStr);
    const lead = leadMap[leadId];
    if (!lead) continue;

    const userId = lead.responsible_user_id;
    const userName = userMap[userId] || `User ${userId}`;

    if (!userSLA[userId]) {
      userSLA[userId] = {
        id: userId, name: userName,
        total_responses: 0, total_response_minutes: 0,
        within_sla: 0, outside_sla: 0,
        response_times: [], // for median
        leads_count: 0,
      };
    }
    userSLA[userId].leads_count++;

    // Sort events by time
    evts.sort((a, b) => a.created_at - b.created_at);

    let lastIncoming = null;

    for (const evt of evts) {
      const isIncoming = INCOMING_TYPES.includes(evt.type);
      const isOutgoing = OUTGOING_TYPES.includes(evt.type);

      if (isIncoming) {
        // Mark new incoming (only if no pending incoming already)
        if (!lastIncoming) {
          lastIncoming = evt;
        }
      } else if (isOutgoing && lastIncoming) {
        // Response found — calculate time
        const respMinutes = businessMinutes(lastIncoming.created_at, evt.created_at, bh, tzOffset);
        userSLA[userId].total_responses++;
        userSLA[userId].total_response_minutes += respMinutes;
        userSLA[userId].response_times.push(respMinutes);
        if (respMinutes <= slaTarget) {
          userSLA[userId].within_sla++;
        } else {
          userSLA[userId].outside_sla++;
        }
        lastIncoming = null; // reset
      }
    }

    // If there's a pending incoming (no response yet)
    if (lastIncoming) {
      const waitMinutes = businessMinutes(lastIncoming.created_at, now, bh, tzOffset);
      pendingLeads.push({
        lead_id: leadId,
        lead_name: lead.name || `Lead ${leadId}`,
        responsible_id: userId,
        responsible_name: userName,
        pipeline: '',
        incoming_at: lastIncoming.created_at,
        waiting_minutes: Math.round(waitMinutes),
        waiting_total_minutes: Math.round((now - lastIncoming.created_at) / 60),
        over_sla: waitMinutes > slaTarget,
      });
    }
  }

  // Build per-user metrics
  const userMetrics = Object.values(userSLA).map(u => {
    const avg = u.total_responses > 0 ? Math.round(u.total_response_minutes / u.total_responses * 10) / 10 : 0;
    // Median
    u.response_times.sort((a, b) => a - b);
    const median = u.response_times.length > 0
      ? u.response_times[Math.floor(u.response_times.length / 2)]
      : 0;
    const slaRate = u.total_responses > 0
      ? Math.round((u.within_sla / u.total_responses) * 1000) / 10
      : 0;

    return {
      id: u.id,
      name: u.name,
      leads_count: u.leads_count,
      total_responses: u.total_responses,
      avg_response_minutes: avg,
      median_response_minutes: Math.round(median * 10) / 10,
      within_sla: u.within_sla,
      outside_sla: u.outside_sla,
      sla_rate: slaRate,
    };
  }).sort((a, b) => a.avg_response_minutes - b.avg_response_minutes);

  // Sort pending by wait time desc
  pendingLeads.sort((a, b) => b.waiting_minutes - a.waiting_minutes);

  // Global averages
  const allTimes = userMetrics.flatMap(u => []);
  let globalAvg = 0, globalResponses = 0, globalWithinSla = 0;
  userMetrics.forEach(u => {
    globalResponses += u.total_responses;
    globalWithinSla += u.within_sla;
    globalAvg += u.avg_response_minutes * u.total_responses;
  });
  globalAvg = globalResponses > 0 ? Math.round(globalAvg / globalResponses * 10) / 10 : 0;
  const globalSlaRate = globalResponses > 0 ? Math.round((globalWithinSla / globalResponses) * 1000) / 10 : 0;

  return {
    sla_target_minutes: slaTarget,
    global: {
      avg_response_minutes: globalAvg,
      total_responses: globalResponses,
      sla_rate: globalSlaRate,
      pending_count: pendingLeads.length,
      over_sla_count: pendingLeads.filter(p => p.over_sla).length,
    },
    users: userMetrics,
    pending_leads: pendingLeads.slice(0, 50),
  };
}

module.exports = {
  api, apiAll, getToken, getPipelines, getUsers,
  getLossReasons, getSourceFieldOptions, getSourceFieldId, detectSourceField,
  fetchAllLeads, buildDashboardData, getFiltersData,
  fetchMessageEvents, buildSLAData,
};
