/**
 * Bonsai Stays — Hospitable Sync
 * Syncs listing data, availability, and pricing from the Hospitable API.
 *
 * Required environment variables (Netlify UI → Site Settings → Environment):
 *   HOSPITABLE_API_KEY   — Hospitable API key (Settings → API in Hospitable dashboard)
 *   SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key
 */

const HOSPITABLE_API_BASE = 'https://api.hospitable.com/v1';

async function hospitableGet(path, apiKey) {
  apiKey = apiKey || process.env.HOSPITABLE_API_KEY;

  if (!apiKey) {
    throw new Error('Missing Hospitable credentials. Add the API Key to the property in the portal.');
  }

  let res;
  try {
    res = await fetch(`${HOSPITABLE_API_BASE}${path}`, {
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Hospitable API (${path}): ${networkErr.message}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Hospitable API ${path} → ${res.status}: ${text.slice(0, 300)}`);

  try { return JSON.parse(text); }
  catch { throw new Error(`Hospitable API response not JSON for ${path}: ${text.slice(0, 200)}`); }
}

/* ─── Actions ──────────────────────────────────────────────────────────── */

async function syncListing(propertyId, apiKey) {
  const json = await hospitableGet(`/properties/${propertyId}`, apiKey);
  const data = json.data || json;

  return {
    title:       data.name || data.title || '',
    description: data.description || '',
    bedrooms:    data.bedrooms  ?? null,
    bathrooms:   data.bathrooms ?? null,
    guests:      data.accommodates ?? data.max_guests ?? null,
    price:       data.base_price ?? data.price ?? null,
    currency:    data.currency || 'CAD',
    address:     data.address || '',
    thumbnail:   data.thumbnail_url || data.picture_url || '',
  };
}

async function syncAvailability(propertyId, apiKey) {
  const from = new Date().toISOString().split('T')[0];
  const toDate = new Date();
  toDate.setFullYear(toDate.getFullYear() + 1);
  const to = toDate.toISOString().split('T')[0];

  const json = await hospitableGet(`/properties/${propertyId}/calendar?start_date=${from}&end_date=${to}`, apiKey);
  const days = json.data || (Array.isArray(json) ? json : []);

  const blockedDates = days
    .filter(d => d.available === false || d.available === 0 || d.status === 'blocked' || d.status === 'booked')
    .map(d => d.date);

  const prices = {};
  days.forEach(d => {
    const price = d.price ?? d.base_price ?? d.nightly_price ?? null;
    if (d.date && price != null) prices[d.date] = price;
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

  const { action = 'full', listingId, propertyId, apiKey } = body;

  if (!listingId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'listingId is required' }) };
  }

  try {
    const result = {};

    if (action === 'listing' || action === 'full') {
      result.listing = await syncListing(listingId, apiKey);
    }

    if (action === 'availability' || action === 'full') {
      result.availability = await syncAvailability(listingId, apiKey);
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

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, pms: 'hospitable', ...result }) };

  } catch (e) {
    console.error('Hospitable sync error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
