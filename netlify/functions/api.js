/**
 * Bonsai Stays — Public JSON API
 * Netlify function: /.netlify/functions/api
 *
 * ── Endpoints (all GET) ───────────────────────────────────────────────────
 *
 *  ?resource=properties
 *      List all active properties (public-safe fields only).
 *
 *  ?resource=properties&id=UUID
 *      Single property details.
 *
 *  ?resource=availability&property_id=UUID[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 *      Blocked date ranges for one property.
 *      Defaults: from = today, to = today + 365 days.
 *
 *  ?resource=all[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 *      All active properties with their availability bundled in.
 *
 * ── Required env vars (Netlify → Site settings → Environment variables) ───
 *
 *  SUPABASE_URL          — e.g. https://xyzxyz.supabase.co
 *  SUPABASE_SERVICE_KEY  — service-role key (never exposed to the browser)
 *
 * ── Optional env var ──────────────────────────────────────────────────────
 *
 *  BONSAI_API_KEY        — if set, every request must include ?api_key=VALUE
 *                          Leave unset to keep the API fully public.
 *
 * ── Response envelope ─────────────────────────────────────────────────────
 *
 *  Success  →  { "ok": true,  "resource": "...", ... }
 *  Error    →  { "ok": false, "error": "..." }
 */

const { createClient } = require('@supabase/supabase-js');

// ── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Fields safe to expose publicly ───────────────────────────────────────────
const PROPERTY_PUBLIC_FIELDS = [
  'id', 'name', 'city', 'address', 'description',
  'bedrooms', 'bathrooms', 'guests',
  'thumbnail_url', 'photos', 'amenities',
  'airbnb_url', 'vrbo_url', 'active',
].join(', ');

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function dateIn(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function err(statusCode, message) {
  return {
    statusCode,
    headers: CORS,
    body: JSON.stringify({ ok: false, error: message }),
  };
}

function ok(data) {
  return {
    statusCode: 200,
    headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }, // 5-min cache
    body: JSON.stringify({ ok: true, generated_at: new Date().toISOString(), ...data }),
  };
}

// ── Resource handlers ─────────────────────────────────────────────────────────

/**
 * GET ?resource=properties[&id=UUID]
 * Returns public property info. Never exposes door codes, tokens, guest data.
 */
async function getProperties(sb, id) {
  if (id) {
    const { data, error } = await sb
      .from('properties')
      .select(PROPERTY_PUBLIC_FIELDS)
      .eq('id', id)
      .eq('active', true)
      .single();

    if (error || !data) return err(404, `Property not found: ${id}`);
    return ok({ resource: 'property', data });
  }

  const { data, error } = await sb
    .from('properties')
    .select(PROPERTY_PUBLIC_FIELDS)
    .eq('active', true)
    .order('name');

  if (error) return err(500, error.message);
  return ok({ resource: 'properties', count: data.length, data });
}

/**
 * Fetch blocked date ranges for a given property_id within [from, to].
 * Only returns bookings with status: upcoming, active, confirmed.
 * Never exposes guest name, email, phone, door code, or price.
 */
async function fetchAvailability(sb, propertyId, from, to) {
  const { data, error } = await sb
    .from('bookings')
    .select('check_in, check_out, status')
    .eq('property_id', propertyId)
    .in('status', ['upcoming', 'active', 'confirmed'])
    .not('status', 'eq', 'cancelled')
    .gte('check_out', from)   // only bookings that end after the window starts
    .lte('check_in',  to)     // only bookings that start before the window ends
    .order('check_in');

  if (error) throw new Error(error.message);

  return (data || []).map(b => ({
    check_in:  b.check_in,
    check_out: b.check_out,
  }));
}

/**
 * GET ?resource=availability&property_id=UUID[&from=DATE&to=DATE]
 */
async function getAvailability(sb, params) {
  const { property_id, from: fromParam, to: toParam } = params;

  if (!property_id) return err(400, 'property_id is required');

  const from = (fromParam && isValidDate(fromParam)) ? fromParam : today();
  const to   = (toParam   && isValidDate(toParam))   ? toParam   : dateIn(365);

  if (from > to) return err(400, 'from must be before to');

  // Look up property name
  const { data: prop, error: propErr } = await sb
    .from('properties')
    .select('id, name, city')
    .eq('id', property_id)
    .eq('active', true)
    .single();

  if (propErr || !prop) return err(404, `Property not found: ${property_id}`);

  let blocked;
  try {
    blocked = await fetchAvailability(sb, property_id, from, to);
  } catch (e) {
    return err(500, e.message);
  }

  return ok({
    resource:    'availability',
    property:    { id: prop.id, name: prop.name, city: prop.city },
    from,
    to,
    blocked_count: blocked.length,
    blocked,
  });
}

/**
 * GET ?resource=all[&from=DATE&to=DATE]
 * All active properties with availability bundled in.
 */
async function getAll(sb, params) {
  const from = (params.from && isValidDate(params.from)) ? params.from : today();
  const to   = (params.to   && isValidDate(params.to))   ? params.to   : dateIn(365);

  if (from > to) return err(400, 'from must be before to');

  const { data: properties, error: propErr } = await sb
    .from('properties')
    .select(PROPERTY_PUBLIC_FIELDS)
    .eq('active', true)
    .order('name');

  if (propErr) return err(500, propErr.message);

  // Fetch all relevant bookings in one query across all properties
  const propertyIds = properties.map(p => p.id);

  const { data: bookings, error: bookErr } = await sb
    .from('bookings')
    .select('property_id, check_in, check_out, status')
    .in('property_id', propertyIds)
    .in('status', ['upcoming', 'active', 'confirmed'])
    .gte('check_out', from)
    .lte('check_in',  to)
    .order('check_in');

  if (bookErr) return err(500, bookErr.message);

  // Group bookings by property_id
  const byProperty = {};
  for (const b of bookings || []) {
    if (!byProperty[b.property_id]) byProperty[b.property_id] = [];
    byProperty[b.property_id].push({ check_in: b.check_in, check_out: b.check_out });
  }

  const data = properties.map(p => ({
    ...p,
    availability: {
      from,
      to,
      blocked: byProperty[p.id] || [],
    },
  }));

  return ok({ resource: 'all', from, to, count: data.length, data });
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // Only GET
  if (event.httpMethod !== 'GET') {
    return err(405, 'Method not allowed. Use GET.');
  }

  // ── API key check (optional) ────────────────────────────────────────────
  const requiredKey = process.env.BONSAI_API_KEY;
  if (requiredKey) {
    const providedKey =
      event.queryStringParameters?.api_key ||
      (event.headers?.['x-api-key'] ?? '');
    if (providedKey !== requiredKey) {
      return err(401, 'Invalid or missing api_key.');
    }
  }

  // ── Supabase client ─────────────────────────────────────────────────────
  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) {
    return err(500, 'Server not configured: missing SUPABASE_SERVICE_KEY.');
  }

  const sb = createClient(SB_URL, SB_KEY);

  // ── Route ───────────────────────────────────────────────────────────────
  const params   = event.queryStringParameters || {};
  const resource = (params.resource || '').toLowerCase();

  switch (resource) {
    case 'properties':
      return getProperties(sb, params.id || null);

    case 'availability':
      return getAvailability(sb, params);

    case 'all':
      return getAll(sb, params);

    default:
      return ok({
        resource: 'index',
        message:  'Bonsai Stays API — see documentation for available endpoints.',
        endpoints: [
          {
            url:         '/.netlify/functions/api?resource=properties',
            description: 'List all active properties',
          },
          {
            url:         '/.netlify/functions/api?resource=properties&id=UUID',
            description: 'Single property details',
          },
          {
            url:         '/.netlify/functions/api?resource=availability&property_id=UUID&from=YYYY-MM-DD&to=YYYY-MM-DD',
            description: 'Blocked date ranges for a property (from/to optional, defaults to today → +1 year)',
          },
          {
            url:         '/.netlify/functions/api?resource=all&from=YYYY-MM-DD&to=YYYY-MM-DD',
            description: 'All properties with availability bundled in',
          },
        ],
      });
  }
};
