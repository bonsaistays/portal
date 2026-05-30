// ecobee.js — All Ecobee API operations
// POST /.netlify/functions/ecobee  with JSON body { action, ...params }
//
// Actions:
//   pin                          → start OAuth: returns { pin, code }
//   token    { code }            → exchange PIN code for tokens; saves to Supabase
//   refresh                      → refresh access token; saves new one
//   status   { thermostat_id }   → current temp, mode, setpoints
//   set      { thermostat_id, heat_temp, cool_temp }  → set setpoints (°F)
//   list                         → list all thermostats on connected account

const ECOBEE_API   = 'https://api.ecobee.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SB_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_KEY      = process.env.ECOBEE_API_KEY;  // from developer.ecobee.com

// ── Supabase helpers ──────────────────────────────────────────────────────
async function sbGet(table, filter = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${filter}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  return r.json();
}

async function sbUpsert(table, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(data),
  });
}

// ── Token management ──────────────────────────────────────────────────────
async function getTokens() {
  const rows = await sbGet('ecobee_tokens', '?id=eq.main&select=access_token,refresh_token,token_expires_at');
  return rows?.[0] || null;
}

async function saveTokens(access_token, refresh_token, expires_in) {
  await sbUpsert('ecobee_tokens', {
    id: 'main',
    access_token,
    refresh_token,
    token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
  });
}

async function getValidAccessToken() {
  const tokens = await getTokens();
  if (!tokens) throw new Error('Ecobee not connected. Connect it in the portal first.');

  // If token expires in less than 5 minutes, refresh it
  const expiresAt = new Date(tokens.token_expires_at).getTime();
  if (Date.now() > expiresAt - 300_000) {
    const r = await fetch(`${ECOBEE_API}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id:     API_KEY,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error('Token refresh failed: ' + (d.error_description || d.error));
    await saveTokens(d.access_token, d.refresh_token, d.expires_in);
    return d.access_token;
  }
  return tokens.access_token;
}

// ── Ecobee API call helper ────────────────────────────────────────────────
async function ecobeeGet(path, params = {}) {
  const token = await getValidAccessToken();
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${ECOBEE_API}${path}${qs ? '?' + qs : ''}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.status?.message || JSON.stringify(d));
  return d;
}

async function ecobeePost(path, body) {
  const token = await getValidAccessToken();
  const r = await fetch(`${ECOBEE_API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.status?.message || JSON.stringify(d));
  return d;
}

// ── Handler ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'ECOBEE_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action } = body;

  try {
    // ── 1. Start OAuth: get PIN ────────────────────────────────────────────
    if (action === 'pin') {
      const r = await fetch(`${ECOBEE_API}/authorize?response_type=ecobeePin&client_id=${API_KEY}&scope=smartWrite`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error_description || d.error || 'Auth failed');
      // d = { ecobeePin, code, expires_in, pin_expires_in, ... }
      return ok({ pin: d.ecobeePin, code: d.code, expires_in: d.pin_expires_in });
    }

    // ── 2. Exchange code → tokens ──────────────────────────────────────────
    if (action === 'token') {
      const { code } = body;
      const r = await fetch(`${ECOBEE_API}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'ecobeePin',
          code,
          client_id: API_KEY,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error_description || d.error || 'Token exchange failed');
      await saveTokens(d.access_token, d.refresh_token, d.expires_in);
      return ok({ connected: true });
    }

    // ── 3. List all thermostats ────────────────────────────────────────────
    if (action === 'list') {
      const selection = JSON.stringify({
        selection: { selectionType: 'registered', selectionMatch: '', includeRuntime: true },
      });
      const d = await ecobeeGet('/1/thermostat', { json: selection });
      const thermostats = (d.thermostatList || []).map(t => ({
        id:         t.identifier,
        name:       t.name,
        heat_temp:  t.runtime?.actualTemperature ? Math.round(t.runtime.actualTemperature / 10) : null,
        // actualTemperature is in tenths of a degree F
        actual_f:   t.runtime?.actualTemperature != null ? (t.runtime.actualTemperature / 10).toFixed(1) : null,
        actual_c:   t.runtime?.actualTemperature != null ? (((t.runtime.actualTemperature / 10) - 32) * 5 / 9).toFixed(1) : null,
        heat_set_f: t.runtime?.desiredHeat != null ? (t.runtime.desiredHeat / 10).toFixed(0) : null,
        cool_set_f: t.runtime?.desiredCool != null ? (t.runtime.desiredCool / 10).toFixed(0) : null,
        hvac_mode:  t.settings?.hvacMode || 'unknown',
      }));
      return ok({ thermostats });
    }

    // ── 4. Get status for one thermostat ──────────────────────────────────
    if (action === 'status') {
      const { thermostat_id } = body;
      if (!thermostat_id) throw new Error('thermostat_id required');
      const selection = JSON.stringify({
        selection: { selectionType: 'thermostats', selectionMatch: thermostat_id, includeRuntime: true, includeSettings: true },
      });
      const d = await ecobeeGet('/1/thermostat', { json: selection });
      const t = d.thermostatList?.[0];
      if (!t) throw new Error('Thermostat not found: ' + thermostat_id);
      return ok({
        id:         t.identifier,
        name:       t.name,
        actual_f:   t.runtime?.actualTemperature != null ? (t.runtime.actualTemperature / 10).toFixed(1) : null,
        actual_c:   t.runtime?.actualTemperature != null ? (((t.runtime.actualTemperature / 10) - 32) * 5 / 9).toFixed(1) : null,
        heat_set_f: t.runtime?.desiredHeat  != null ? (t.runtime.desiredHeat  / 10).toFixed(0) : null,
        cool_set_f: t.runtime?.desiredCool  != null ? (t.runtime.desiredCool  / 10).toFixed(0) : null,
        hvac_mode:  t.settings?.hvacMode || 'auto',
      });
    }

    // ── 5. Set temperature ─────────────────────────────────────────────────
    if (action === 'set') {
      const { thermostat_id, heat_temp_f, cool_temp_f, hvac_mode } = body;
      if (!thermostat_id) throw new Error('thermostat_id required');

      // Ecobee uses tenths of a degree
      const heatSet = heat_temp_f != null ? Math.round(heat_temp_f * 10) : undefined;
      const coolSet = cool_temp_f != null ? Math.round(cool_temp_f * 10) : undefined;

      const payload = {
        selection: { selectionType: 'thermostats', selectionMatch: thermostat_id },
        thermostat: {
          settings: { hvacMode: hvac_mode || 'auto' },
          ...(heatSet !== undefined || coolSet !== undefined ? {
            // Use setHold to override current program
          } : {}),
        },
      };

      // Use the setHold function to apply temps without permanently changing the schedule
      const holdPayload = {
        selection: { selectionType: 'thermostats', selectionMatch: thermostat_id },
        functions: [{
          type: 'setHold',
          params: {
            holdType:         'nextTransition',
            ...(heatSet !== undefined ? { heatHoldTemp: heatSet } : {}),
            ...(coolSet !== undefined ? { coolHoldTemp: coolSet } : {}),
          },
        }],
      };

      await ecobeePost('/1/thermostat', holdPayload);
      return ok({ set: true });
    }

    // ── 6. Resume normal schedule (revert to owner program) ───────────────
    if (action === 'resume') {
      const { thermostat_id } = body;
      if (!thermostat_id) throw new Error('thermostat_id required');
      await ecobeePost('/1/thermostat', {
        selection: { selectionType: 'thermostats', selectionMatch: thermostat_id },
        functions: [{ type: 'resumeProgram', params: { resumeAll: true } }],
      });
      return ok({ resumed: true });
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function ok(data) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...data }) };
}
