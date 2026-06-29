/**
 * Guesty Sync — Bonsai Stays
 * Syncs listing data, availability, pricing, and reservations from Guesty Open API.
 *
 * Required environment variables (Netlify UI → Site Settings → Environment):
 *   GUESTY_CLIENT_ID      — Guesty OAuth2 client ID
 *   GUESTY_CLIENT_SECRET  — Guesty OAuth2 client secret
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase service role key
 */

const GUESTY_TOKEN_URL = 'https://booking.guesty.com/oauth2/token';
const GUESTY_API_BASE  = 'https://booking.guesty.com/api';

let _cachedToken = null;
let _tokenExpiry = 0;

async function getGuestyToken(clientId, clientSecret) {
  if (_cachedToken && Date.now() < _tokenExpiry - 30_000) return _cachedToken;

  clientId     = clientId     || process.env.GUESTY_CLIENT_ID;
  clientSecret = clientSecret || process.env.GUESTY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing Guesty credentials. Add Client ID and Client Secret to the property in the portal.');
  }

  let res;
  try {
    res = await fetch(GUESTY_TOKEN_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Guesty auth server (${GUESTY_TOKEN_URL}): ${networkErr.message}`);
  }

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Guesty auth failed (${res.status}): ${text.slice(0, 300)}`);
  }

  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Guesty auth response was not JSON: ${text.slice(0, 200)}`); }

  if (!json.access_token) {
    throw new Error(`Guesty auth returned no access_token. Response: ${JSON.stringify(json).slice(0, 300)}`);
  }

  _cachedToken = json.access_token;
  _tokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  return _cachedToken;
}

async function guestyGet(path, clientId, clientSecret) {
  const token = await getGuestyToken(clientId, clientSecret);

  let res;
  try {
    res = await fetch(`${GUESTY_API_BASE}${path}`, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Guesty API (${path}): ${networkErr.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Guesty API ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }

  try { return JSON.parse(text); }
  catch { throw new Error(`Guesty API response not JSON for ${path}: ${text.slice(0, 200)}`); }
}

/* ─── Actions ──────────────────────────────────────────────────────────── */

async function syncListing(listingId, clientId, clientSecret) {
  const data = await guestyGet(`/listings/${listingId}`, clientId, clientSecret);
  return {
    title:       data.title || data.nickname || '',
    description: data.publicDescription?.summary || '',
    bedrooms:    data.bedrooms  ?? null,
    bathrooms:   data.bathrooms ?? null,
    guests:      data.accommodates ?? null,
    price:       data.prices?.basePrice ?? null,
    currency:    data.prices?.currency || 'CAD',
    address:     data.address?.full || '',
    thumbnail:   data.pictures?.[0]?.original || '',
  };
}

async function syncAvailability(listingId, clientId, clientSecret) {
  const from = new Date().toISOString().split('T')[0];
  const toDate = new Date();
  toDate.setFullYear(toDate.getFullYear() + 1);
  const to = toDate.toISOString().split('T')[0];

  // booking.guesty.com v2 calendar endpoint
  const data = await guestyGet(`/listings/${listingId}/calendar?from=${from}&to=${to}`, clientId, clientSecret);

  // Response: { results: [{date, status, price}] } or array
  const days = Array.isArray(data) ? data : (data.results || data.days || data.data || []);
  const blockedDates = days
    .filter(d => d.status && d.status !== 'available')
    .map(d => d.date);

  // Also capture per-day prices (Guesty returns price on each calendar day)
  const prices = {};
  days.forEach(d => {
    if (d.date && d.price != null) prices[d.date] = d.price;
  });

  return { from, to, blockedDates, prices };
}

async function syncPricing(listingId, clientId, clientSecret) {
  const from = new Date().toISOString().split('T')[0];
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + 90);
  const to = toDate.toISOString().split('T')[0];

  const data = await guestyGet(`/listings/${listingId}/calendar?from=${from}&to=${to}`, clientId, clientSecret);

  const days = Array.isArray(data) ? data : (data.results || data.days || data.data || []);
  const prices = {};
  days.forEach(d => {
    if (d.price != null) prices[d.date] = d.price;
  });

  return { from, to, prices };
}

async function syncReservations(listingId, propertyId, sb) {
  const now = new Date().toISOString().split('T')[0];

  // Fetch up to 50 upcoming/active reservations for this listing
  const data = await guestyGet(
    `/reservations?listingId=${listingId}&checkOut[$gte]=${now}&status[]=confirmed&status[]=reserved&status[]=checked_in&limit=50`,
  );

  const reservations = data.results || data.data || (Array.isArray(data) ? data : []);
  const upserted = [];
  const errors   = [];

  for (const r of reservations) {
    const record = {
      property_id:       propertyId,
      // ical_uid reused as the external deduplication key
      ical_uid:          `guesty-${r._id}`,
      check_in:          (r.checkIn  || '').split('T')[0],
      check_out:         (r.checkOut || '').split('T')[0],
      status:            mapStatus(r.status),
      guests:            r.guestsCount || 1,
      total_price:       r.money?.totalPaid || r.money?.fareAccommodation || null,
      currency:          r.money?.currency || 'CAD',
      confirmation_code: r.confirmationCode || r._id,
      guest_name:        `${r.guest?.firstName || ''} ${r.guest?.lastName || ''}`.trim() || 'Guest',
      guest_email:       r.guest?.email || null,
      guest_phone:       r.guest?.phone || null,
      source:            'guesty',
    };

    if (!record.check_in || !record.check_out) continue;

    if (sb) {
      const { error } = await sb
        .from('bookings')
        .upsert(record, { onConflict: 'ical_uid', ignoreDuplicates: false });
      if (!error) upserted.push(r._id);
      else { errors.push(error.message); console.error('Supabase upsert error:', error.message); }
    } else {
      upserted.push(r._id);
    }
  }

  return { total: reservations.length, upserted: upserted.length, errors };
}

function mapStatus(s) {
  switch ((s || '').toLowerCase()) {
    case 'confirmed':   return 'confirmed';
    case 'reserved':    return 'confirmed';
    case 'checked_in':  return 'active';
    case 'checked_out': return 'completed';
    case 'cancelled':   return 'cancelled';
    default:            return s;
  }
}

/* ─── Handler ──────────────────────────────────────────────────────────── */

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

  const { action = 'full', listingId, propertyId, clientId, clientSecret } = body;

  if (!listingId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'listingId is required' }) };
  }

  // Optionally connect to Supabase for reservation upserts
  let sb = null;
  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (SB_KEY && propertyId) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      sb = createClient(SB_URL, SB_KEY);
    } catch (e) {
      console.warn('Could not load supabase-js:', e.message);
    }
  }

  try {
    const result = {};

    if (action === 'listing' || action === 'full') {
      result.listing = await syncListing(listingId, clientId, clientSecret);
    }

    if (action === 'availability' || action === 'full') {
      result.availability = await syncAvailability(listingId, clientId, clientSecret);
    }

    if (action === 'pricing' || action === 'full') {
      // pricing reuses the same calendar call — skip to avoid double request
      if (!result.availability) {
        result.pricing = await syncPricing(listingId, clientId, clientSecret);
      } else {
        // derive prices from the availability data we already have
        result.pricing = { note: 'Use availability data for pricing' };
      }
    }

    if ((action === 'reservations' || action === 'full') && propertyId) {
      result.reservations = await syncReservations(listingId, propertyId, sb);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };

  } catch (e) {
    console.error('Guesty sync error:', e.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
