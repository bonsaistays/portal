/**
 * Guesty Sync — Bonsai Stays
 * Syncs listing data, availability, pricing, and reservations from Guesty Open API.
 *
 * Required environment variables (Netlify UI → Site Settings → Environment):
 *   GUESTY_CLIENT_ID      — Guesty OAuth2 client ID
 *   GUESTY_CLIENT_SECRET  — Guesty OAuth2 client secret
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase service role key
 *
 * POST body: { action, listingId, propertyId }
 *   action:
 *     "listing"       — fetch listing details (name, bedrooms, price, description)
 *     "availability"  — fetch available/blocked dates for next 12 months
 *     "pricing"       — fetch nightly pricing for next 90 days
 *     "reservations"  — fetch upcoming reservations and upsert into bookings table
 *     "full"          — run listing + availability + pricing + reservations
 */

const GUESTY_TOKEN_URL = 'https://auth.guesty.com/oauth/token';
const GUESTY_API_BASE  = 'https://open-api.guesty.com/v1';

// In-memory token cache (lives for the duration of the lambda invocation)
let _cachedToken = null;
let _tokenExpiry = 0;

async function getGuestyToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 30_000) return _cachedToken;

  const clientId     = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GUESTY_CLIENT_ID / GUESTY_CLIENT_SECRET not configured');

  const res = await fetch(GUESTY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'open-api:public',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Guesty token error ${res.status}: ${text}`);
  }

  const json = await res.json();
  _cachedToken = json.access_token;
  _tokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  return _cachedToken;
}

async function guestyGet(path) {
  const token = await getGuestyToken();
  const res = await fetch(`${GUESTY_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Guesty GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

/* ─── Actions ──────────────────────────────────────────────────────────── */

async function syncListing(listingId) {
  const data = await guestyGet(`/listings/${listingId}`);
  return {
    title:       data.title || data.nickname || '',
    description: data.publicDescription?.summary || '',
    bedrooms:    data.bedrooms ?? null,
    bathrooms:   data.bathrooms ?? null,
    guests:      data.accommodates ?? null,
    price:       data.prices?.basePrice ?? null,
    currency:    data.prices?.currency || 'CAD',
    address:     data.address?.full || '',
    thumbnail:   data.pictures?.[0]?.original || '',
    raw:         data,
  };
}

async function syncAvailability(listingId) {
  // Guesty calendar endpoint returns day-level availability
  const from = new Date().toISOString().split('T')[0];
  const toDate = new Date();
  toDate.setFullYear(toDate.getFullYear() + 1);
  const to = toDate.toISOString().split('T')[0];

  const data = await guestyGet(`/availability-pricing/api/v3/listings/${listingId}?startDate=${from}&endDate=${to}&fields=status`);

  // data.days: [{date, status}]  status: "available" | "unavailable" | "booked"
  const blocked = (data.days || [])
    .filter(d => d.status !== 'available')
    .map(d => d.date);

  return { from, to, blockedDates: blocked };
}

async function syncPricing(listingId) {
  const from = new Date().toISOString().split('T')[0];
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + 90);
  const to = toDate.toISOString().split('T')[0];

  const data = await guestyGet(`/availability-pricing/api/v3/listings/${listingId}?startDate=${from}&endDate=${to}&fields=price`);

  // Build a map of date → price
  const prices = {};
  (data.days || []).forEach(d => {
    if (d.price != null) prices[d.date] = d.price;
  });

  return { from, to, prices };
}

async function syncReservations(listingId, propertyId, sb) {
  // Fetch upcoming + active reservations
  const now = new Date().toISOString().split('T')[0];
  const data = await guestyGet(
    `/reservations?listingId=${listingId}&checkInFrom=${now}&status=confirmed,reserved,checked_in&limit=50&fields=_id,checkIn,checkOut,guest,money,status,guestsCount,confirmationCode`
  );

  const reservations = data.results || [];
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
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

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
    } catch { /* supabase-js not available — skip DB writes */ }
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
      result.pricing = await syncPricing(listingId);
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
