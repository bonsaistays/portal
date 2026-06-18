/**
 * Bonsai Stays — Unified PMS Sync Dispatcher
 * Routes sync requests to the correct PMS adapter based on the property's pms_type.
 *
 * POST body:
 *   { propertyId: "uuid" }          — looks up pms_type and pms_listing_id from Supabase
 *   { propertyId, action: "full" }  — action passed through to adapter (full | listing | availability)
 *
 * Supported pms_type values:  guesty | hostaway | hospitable
 *
 * Required env vars:
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY
 *   GUESTY_CLIENT_ID / GUESTY_CLIENT_SECRET        (for guesty)
 *   HOSTAWAY_CLIENT_ID / HOSTAWAY_CLIENT_SECRET    (for hostaway)
 *   HOSPITABLE_API_KEY                             (for hospitable)
 */

const { createClient } = require('@supabase/supabase-js');

const ADAPTERS = {
  guesty:      require('./guesty-sync'),
  hostaway:    require('./hostaway-sync'),
  hospitable:  require('./hospitable-sync'),
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing SUPABASE_SERVICE_KEY' }) };

  const sb = createClient(SB_URL, SB_KEY);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const { propertyId, action = 'full' } = body;

  // ── Scheduled / bulk run: no propertyId → sync all auto-sync properties ──
  if (!propertyId) {
    const { data: allProps } = await sb
      .from('properties')
      .select('id, name, pms_type, pms_listing_id, guesty_listing_id, guesty_client_id, guesty_client_secret, hostaway_listing_id, hostaway_client_id, hostaway_client_secret, hospitable_property_id, hospitable_api_key')
      .eq('active', true)
      .neq('auto_sync_bookings', false);

    const results = [];
    for (const p of allProps || []) {
      const pmsType = p.pms_type || (p.guesty_listing_id ? 'guesty' : null) || (p.hostaway_listing_id ? 'hostaway' : null) || (p.hospitable_property_id ? 'hospitable' : null);
      if (!pmsType) continue;
      try {
        const adapter = ADAPTERS[pmsType];
        if (!adapter) continue;
        const listingId = p.pms_listing_id || p.guesty_listing_id || p.hostaway_listing_id || p.hospitable_property_id;
        const credentials = pmsType === 'guesty' ? { clientId: p.guesty_client_id, clientSecret: p.guesty_client_secret }
          : pmsType === 'hostaway' ? { clientId: p.hostaway_client_id, clientSecret: p.hostaway_client_secret }
          : { apiKey: p.hospitable_api_key };
        const res = await adapter.handler({ httpMethod: 'POST', body: JSON.stringify({ action, listingId, propertyId: p.id, ...credentials }) });
        await sb.from('properties').update({ last_synced_at: new Date().toISOString() }).eq('id', p.id);
        results.push({ property: p.name, status: res.statusCode });
      } catch (e) {
        results.push({ property: p.name, error: e.message });
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ bulk: true, results }) };
  }

  // ── Single property sync (manual "Sync Now") ─────────────────────────────
  const { data: prop, error: propErr } = await sb
    .from('properties')
    .select(`
      id, name, pms_type, pms_listing_id,
      guesty_listing_id, guesty_client_id, guesty_client_secret,
      hostaway_listing_id, hostaway_client_id, hostaway_client_secret,
      hospitable_property_id, hospitable_api_key
    `)
    .eq('id', propertyId)
    .single();

  if (propErr || !prop) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: `Property not found: ${propertyId}` }) };
  }

  // Determine PMS type — explicit pms_type wins, then fall back to whichever ID is populated
  const pmsType = prop.pms_type
    || (prop.guesty_listing_id       ? 'guesty'     : null)
    || (prop.hostaway_listing_id     ? 'hostaway'   : null)
    || (prop.hospitable_property_id  ? 'hospitable' : null);

  if (!pmsType) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Property "${prop.name}" has no PMS configured.` }) };
  }

  const listingId = prop.pms_listing_id
    || prop.guesty_listing_id
    || prop.hostaway_listing_id
    || prop.hospitable_property_id;

  const adapter = ADAPTERS[pmsType];
  if (!adapter) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unsupported pms_type: "${pmsType}"` }) };
  }

  // Build credential payload for the adapter
  const credentials =
    pmsType === 'guesty'     ? { clientId: prop.guesty_client_id,    clientSecret: prop.guesty_client_secret }
  : pmsType === 'hostaway'   ? { clientId: prop.hostaway_client_id,  clientSecret: prop.hostaway_client_secret }
  : pmsType === 'hospitable' ? { apiKey:   prop.hospitable_api_key }
  : {};

  // Delegate to the adapter's handler by constructing a synthetic event
  const syntheticEvent = {
    httpMethod: 'POST',
    body: JSON.stringify({ action, listingId, propertyId, ...credentials }),
  };

  const response = await adapter.handler(syntheticEvent);
  if (response.statusCode === 200) {
    await sb.from('properties').update({ last_synced_at: new Date().toISOString() }).eq('id', propertyId);
  }
  return { ...response, headers: { ...headers, ...(response.headers || {}) } };
};
