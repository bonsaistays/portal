/**
 * Bonsai Stays — Manual iCal Sync (HTTP)
 * Called by the portal's "Sync Now" button.
 * Same logic as ical-sync.js but as a regular HTTP function (not scheduled).
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing SUPABASE_SERVICE_KEY' }) };
  }

  const sb = createClient(SB_URL, SB_KEY);

  // Optional: sync a single property (POST body { propertyId })
  let propertyId = null;
  try {
    const body = JSON.parse(event.body || '{}');
    propertyId = body.propertyId || null;
  } catch {}

  let query = sb.from('properties').select('id, name, ical_urls').eq('active', true);
  if (propertyId) query = query.eq('id', propertyId);

  const { data: properties, error: propErr } = await query;

  if (propErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: propErr.message }) };
  }

  const propList = properties || [];
  const results  = {
    synced: 0,
    errors: [],
    debug: {
      propertiesFound:    propList.length,
      propertiesWithUrls: propList.filter(p => Array.isArray(p.ical_urls) && p.ical_urls.length).length,
    },
  };

  const today   = new Date().toISOString().split('T')[0];
  const allRecs = [];

  for (const prop of propList) {
    const icalUrls = Array.isArray(prop.ical_urls) ? prop.ical_urls : [];

    for (const entry of icalUrls) {
      const url      = typeof entry === 'string' ? entry : entry?.url;
      const platform = typeof entry === 'object' ? (entry?.platform || 'iCal') : 'iCal';
      if (!url || !url.startsWith('http')) continue;

      try {
        const events = await fetchAndParseICal(url);

        for (const ev of events) {
          if (!ev.start || !ev.end) continue;
          if (ev.end < today) continue;
          if (!ev.uid) continue;

          const status = ev.start <= today && ev.end >= today ? 'active' : 'upcoming';
          const summary = (ev.summary || '').trim();

          // "Reservation HMTAWSTHHR" — Guesty/Airbnb puts the confirmation code in SUMMARY
          const reservationCodeMatch = summary.match(/^Reservation\s+([A-Z0-9]{5,})/i);
          // Generic platform placeholders (not a real guest name)
          const genericTerms = /^(reserved|blocked|not available|airbnb|vrbo|homeaway|booking\.com|unavailable|closed|reservation\b)/i;

          const isGeneric = !summary || genericTerms.test(summary);
          const guestName = isGeneric ? null : summary;
          const confirmationCode = reservationCodeMatch ? reservationCodeMatch[1] : null;

          allRecs.push({
            property_id:          prop.id,
            ical_uid:             ev.uid,
            check_in:             ev.start,
            check_out:            ev.end,
            guest_name:           guestName,
            airbnb_confirmation:  confirmationCode,
            source:               'ical',
            status,
          });
        }
      } catch (e) {
        results.errors.push(`${prop.name} [${platform}]: ${e.message}`);
      }
    }
  }

  if (allRecs.length) {
    const { error } = await sb
      .from('bookings')
      .upsert(allRecs, { onConflict: 'ical_uid', ignoreDuplicates: false });
    if (error) {
      results.errors.push(error.message);
    } else {
      results.synced = allRecs.length;
    }
  }

  if (propList.length) {
    await sb.from('properties')
      .update({ last_synced_at: new Date().toISOString() })
      .in('id', propList.map(p => p.id));
  }

  // Enrich bookings with Guesty guest details (name, email, phone, guests)
  try {
    const enriched = await enrichFromGuesty(sb);
    results.enriched = enriched;
  } catch (e) {
    results.guestyError = e.message;
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...results }) };
};

// ── Guesty enrichment ─────────────────────────────────────────────────────────

let _guestyToken = null;
let _guestyTokenExpiry = 0;

async function getGuestyToken() {
  const clientId     = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (_guestyToken && Date.now() < _guestyTokenExpiry) return _guestyToken;

  const res = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'open-api', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Guesty auth failed: ${res.status}`);
  const data = await res.json();
  _guestyToken = data.access_token;
  _guestyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _guestyToken;
}

async function enrichFromGuesty(sb) {
  const token = await getGuestyToken();
  if (!token) return 0;

  // Fetch upcoming + active reservations from Guesty
  const from = new Date().toISOString().split('T')[0];
  const to   = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const params = new URLSearchParams({ checkInFrom: from, checkOutTo: to, status: 'confirmed,checked_in', limit: '100' });

  const res = await fetch(`https://open-api.guesty.com/v1/reservations?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Guesty reservations failed: ${res.status}`);

  const data = await res.json();
  const reservations = data.results || data.data || [];
  let enriched = 0;

  for (const r of reservations) {
    const checkIn  = (r.checkIn  || '').split('T')[0];
    const checkOut = (r.checkOut || '').split('T')[0];
    const firstName = r.guest?.firstName || '';
    const lastName  = r.guest?.lastName  || '';
    const guestName = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
    if (!checkIn || !checkOut || !guestName) continue;

    const { error } = await sb.from('bookings').update({
      guest_name:          guestName,
      guest_email:         r.guest?.email || null,
      guest_phone:         r.guest?.phone || null,
      num_guests:          r.guestsCount  || null,
      airbnb_confirmation: r.confirmationCode || null,
    })
    .eq('check_in', checkIn)
    .eq('check_out', checkOut)
    .is('guest_email', null); // only update rows that haven't been enriched yet

    if (!error) enriched++;
  }
  return enriched;
}

async function fetchAndParseICal(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseICal(await res.text());
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function parseICal(text) {
  const events = [];
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r\n|\r|\n/);
  let inEvent = false, dtstart = null, dtend = null, uid = null, summary = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; dtstart = dtend = uid = summary = null; }
    else if (line === 'END:VEVENT') {
      if (inEvent && dtstart && dtend) events.push({ start: dtstart, end: dtend, uid, summary });
      inEvent = false;
    } else if (inEvent) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).split(';')[0].toUpperCase();
      const val = line.slice(colon + 1).trim();
      if      (key === 'DTSTART') dtstart = toDateStr(val);
      else if (key === 'DTEND')   dtend   = toDateStr(val);
      else if (key === 'UID')     uid     = val;
      else if (key === 'SUMMARY') summary = val;
    }
  }
  return events;
}

function toDateStr(val) {
  const d = val.replace(/T[\d]{6}Z?$/, '').replace(/Z$/, '');
  return d.length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : d;
}
