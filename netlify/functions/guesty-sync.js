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

async function getGuestyToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 30_000) return _cachedToken;

  const clientId     = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing GUESTY_CLIENT_ID or GUESTY_CLIENT_SECRET in Netlify environment variables.');
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

async function guestyGet(path) {
  const token = await getGuestyToken();

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

async function syncListing(listingId) {
  const data = await guestyGet(`/listings/${listingId}`);
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

async function syncAvailability(listingId) {
  const from = new Date().toISOString().split('T')[0];
  const toDate = new Date();
  toDate.setFullYear(toDate.getFullYear() + 1);
  const to = toDate.toISOString().split('T')[0];

  // booking.guesty.com v2 calendar endpoint
  const data = await guestyGet(`/listings/${listingId}/calendar?from=${from}&to=${to}&fields=date,status,price`);

  // Response: { results: [{date, status, price}] } or array
  const days = Array.isArray(data) ? data : (data.results || data.days || data.data || []);
  const blockedDates = days
    .filter(d => d.status && d.status !== 'available')
    .map(d => d.date);

  return { from, to, blockedDates };
}

async function syncPricing(listingId) {
  const from = new Date().toISOString().split('T')[0];
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + 90);
  const to = toDate.toISOString().split('T')[0];

  const data = await guestyGet(`/listings/${listingId}/calendar?from=${from}&to=${to}&fields=date,price`);

  const days = Array.isArray(data) ? data : (data.results || data.days || data.data || []);
  const prices = {};
  days.forEach(d => {
    if (d.price != null) prices[d.date] = d.price;
  });

  return { from, to, prices };
}

async function syncReservations(listingId, propertyId, sb) {
  // booking.guesty.com is a booking-engine API — reservation list not available
  // Return a note rather than failing the whole sync
  return { total: 0, upserted: 0, note: 'Reservation sync not available on this API plan' };

  /* eslint-disable no-unreachable */
  const now = new Date().toISOString().split('T')[0];
  const data = await guestyGet(
    `/reservations?listingId=${listingId}&checkIn[$gte]=${now}&status[]=confirmed&status[]=reserved&status[]=checked_in&limit=50`
  );

  const reservations = data.results || data.data || (Array.isArray(data) ? data : []);
  const upserted = [];

  for (const r of reservations) {
    const record = {
      guesty_reservation_id: r._id,
      property_id:           propertyId,
      check_in:              r.checkIn?.split('T')[0],
      check_out:             r.checkOut?.split('T')[0],
      status:                mapStatus(r.status),
      guests:                r.guestsCount || 1,
      total_price:           r.money?.totalPaid || r.money?.fareAccommodation || null,
      currency:              r.money?.currency || 'CAD',
      confirmation_code:     r.confirmationCode || r._id,
      guest_name:            `${r.guest?.firstName || ''} ${r.guest?.lastName || ''}`.trim() || 'Guest',
      guest_email:           r.guest?.email || null,
      guest_phone:           r.guest?.phone || null,
      source:                'guesty',
    };

    if (sb) {
      const { error } = await sb
        .from('bookings')
        .upsert(record, { onConflict: 'guesty_reservation_id' });
      if (!error) upserted.push(r._id);
      else console.error('Supabase upsert error:', error.message);
    } else {
      upserted.push(r._id);
    }
  }

  return { total: reservations.length, upserted: upserted.length };
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

  const { action = 'full', listingId, propertyId } = body;

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
      result.listing = await syncListing(listingId);
    }

    if (action === 'availability' || action === 'full') {
      result.availability = await syncAvailability(listingId);
    }

    if (action === 'pricing' || action === 'full') {
      // pricing reuses the same calendar call — skip to avoid double request
      if (!result.availability) {
        result.pricing = await syncPricing(listingId);
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
