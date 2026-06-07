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
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { propertyId, action = 'full' } = body;

  if (!propertyId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'propertyId is required' }) };
  }

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing SUPABASE_SERVICE_KEY' }) };

  const sb = createClient(SB_URL, SB_KEY);

  // Look up the property — includes per-property credentials
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
  return { ...response, headers: { ...headers, ...(response.headers || {}) } };
};
