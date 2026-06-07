/**
 * Bonsai Stays — Hostaway Sync
 * Syncs listing data, availability, and pricing from the Hostaway API.
 *
 * Required environment variables (Netlify UI → Site Settings → Environment):
 *   HOSTAWAY_CLIENT_ID      — Hostaway OAuth2 client ID
 *   HOSTAWAY_CLIENT_SECRET  — Hostaway OAuth2 client secret
 *   SUPABASE_URL            — Supabase project URL
 *   SUPABASE_SERVICE_KEY    — Supabase service role key
 */

const HOSTAWAY_TOKEN_URL = 'https://api.hostaway.com/v1/accessTokens';
const HOSTAWAY_API_BASE  = 'https://api.hostaway.com/v1';

let _cachedToken = null;
let _tokenExpiry = 0;

async function getHostawayToken(clientId, clientSecret) {
  if (_cachedToken && Date.now() < _tokenExpiry - 30_000) return _cachedToken;

  clientId     = clientId     || process.env.HOSTAWAY_CLIENT_ID;
  clientSecret = clientSecret || process.env.HOSTAWAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing Hostaway credentials. Add Client ID and Client Secret to the property in the portal.');
  }

  let res;
  try {
    res = await fetch(HOSTAWAY_TOKEN_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':        'application/json',
        'Cache-control': 'no-cache',
      },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&scope=general`,
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Hostaway auth server: ${networkErr.message}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Hostaway auth failed (${res.status}): ${text.slice(0, 300)}`);

  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Hostaway auth response was not JSON: ${text.slice(0, 200)}`); }

  if (!json.access_token) {
    throw new Error(`Hostaway auth returned no access_token. Response: ${JSON.stringify(json).slice(0, 300)}`);
  }

  _cachedToken = json.access_token;
  _tokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  return _cachedToken;
}

async function hostawayGet(path, clientId, clientSecret) {
  const token = await getHostawayToken(clientId, clientSecret);

  let res;
  try {
    res = await fetch(`${HOSTAWAY_API_BASE}${path}`, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Hostaway API (${path}): ${networkErr.message}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Hostaway API ${path} → ${res.status}: ${text.slice(0, 300)}`);

  try { return JSON.parse(text); }
  catch { throw new Error(`Hostaway API response not JSON for ${path}: ${text.slice(0, 200)}`); }
}

/* ─── Actions ──────────────────────────────────────────────────────────── */

async function syncListing(listingId, clientId, clientSecret) {
  const json = await hostawayGet(`/listings/${listingId}`, clientId, clientSecret);
  const data = json.result || json;

  return {
    title:       data.name || data.internalListingName || '',
    description: data.description || data.publicDescription || '',
    bedrooms:    data.bedroomsNumber  ?? null,
    bathrooms:   data.bathroomsNumber ?? null,
    guests:      data.guestsIncluded  ?? null,
    price:       data.price ?? data.basePrice ?? null,
    currency:    data.currency || 'CAD',
    address:     [data.address, data.city, data.state].filter(Boolean).join(', '),
    thumbnail:   data.thumbnailUrl || data.image || '',
  };
}

async function syncAvailability(listingId, clientId, clientSecret) {
  const from = new Date().toISOString().split('T')[0];
  const toDate = new Date();
  toDate.setFullYear(toDate.getFullYear() + 1);
  const to = toDate.toISOString().split('T')[0];

  const json = await hostawayGet(`/listings/${listingId}/calendar?startDate=${from}&endDate=${to}`, clientId, clientSecret);
  const days = json.result || (Array.isArray(json) ? json : []);

  const blockedDates = days
    .filter(d => d.isAvailable === 0 || d.isAvailable === false)
    .map(d => d.date);

  const prices = {};
  days.forEach(d => {
    if (d.date && d.price != null) prices[d.date] = d.price;
  });

  return { from, to, blockedDates, prices };
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

  try {
    const result = {};

    if (action === 'listing' || action === 'full') {
      result.listing = await syncListing(listingId, clientId, clientSecret);
    }

    if (action === 'availability' || action === 'full') {
      result.availability = await syncAvailability(listingId, clientId, clientSecret);
    }

    // Upsert availability into Supabase if propertyId provided
    if (result.availability && propertyId) {
      const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
      const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
      if (SB_KEY) {
        try {
          const { createClient } = require('@supabase/supabase-js');
          const sb = createClient(SB_URL, SB_KEY);
          await sb.from('properties').update({
            pms_availability: result.availability,
            pms_synced_at:    new Date().toISOString(),
          }).eq('id', propertyId);
        } catch (e) {
          console.warn('Supabase update error:', e.message);
        }
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, pms: 'hostaway', ...result }) };

  } catch (e) {
    console.error('Hostaway sync error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
