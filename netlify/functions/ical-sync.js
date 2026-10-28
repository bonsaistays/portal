/**
 * Bonsai Stays — iCal → Bookings Sync
 * Netlify scheduled function: runs every 30 minutes
 *
 * Reads iCal URLs stored on each property, parses reservations,
 * and upserts them into the Supabase `bookings` table.
 *
 * iCal feeds (Airbnb, VRBO, etc.) provide dates only — no guest names
 * or emails. Bookings created this way will have:
 *   guest_name  = platform name (e.g. "Airbnb Reservation")
 *   source      = "ical"
 *   status      = "upcoming" or "active" (auto-calculated)
 *
 * Deduplication key: ical_uid (the VEVENT UID from the feed).
 * If no UID, falls back to property_id + check_in + check_out.
 *
 * ── Required env vars ─────────────────────────────────────────────────────
 *  SUPABASE_URL          — Portal Supabase project URL
 *  SUPABASE_SERVICE_KEY  — service role key
 *
 * ── Schedule (netlify.toml) ───────────────────────────────────────────────
 *  Add under [functions."ical-sync"]:  schedule = "*/30 * * * *"
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing SUPABASE_SERVICE_KEY' }) };
  }

  const sb = createClient(SB_URL, SB_KEY);

  // ── Load all active properties with iCal URLs and auto-sync enabled ────────
  const { data: properties, error: propErr } = await sb
    .from('properties')
    .select('id, name, ical_urls')
    .eq('active', true)
    .neq('auto_sync_bookings', false);

  if (propErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: propErr.message }) };
  }

  const propList = properties || [];
  const results  = {
    synced: 0, errors: [],
    debug: {
      propertiesFound:    propList.length,
      propertiesWithUrls: propList.filter(p => Array.isArray(p.ical_urls) && p.ical_urls.length).length,
    },
  };

  const today   = new Date().toISOString().split('T')[0];
  const allRecs = []; // batch all records, upsert once

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
          if (ev.end < today) continue; // skip past bookings
          if (!ev.uid) continue;        // skip events without a UID (can't deduplicate)

          const status  = ev.start <= today && ev.end >= today ? 'active' : 'upcoming';
          const summary = (ev.summary || '').trim();
          const reservationCodeMatch = summary.match(/^Reservation\s+([A-Z0-9]{5,})/i);
          const genericTerms = /^(reserved|blocked|not available|airbnb|vrbo|homeaway|booking\.com|unavailable|closed|reservation\b)/i;
          const isGeneric = !summary || genericTerms.test(summary);

          allRecs.push({
            property_id:         prop.id,
            ical_uid:            ev.uid,
            check_in:            ev.start,
            check_out:           ev.end,
            guest_name:          isGeneric ? null : summary,
            airbnb_confirmation: reservationCodeMatch ? reservationCodeMatch[1] : null,
            source:              'ical',
            status,
          });
        }
      } catch (e) {
        results.errors.push(`${prop.name} [${platform}]: ${e.message}`);
      }
    }
  }

  // Single batch upsert — much faster than one call per booking
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

  // Stamp last_synced_at on all properties in one call
  if (propList.length) {
    await sb.from('properties')
      .update({ last_synced_at: new Date().toISOString() })
      .in('id', propList.map(p => p.id));
  }

  // Enrich bookings with Guesty guest details
  try {
    const enriched = await enrichFromGuesty(sb);
    results.enriched = enriched;
  } catch (e) {
    results.guestyError = e.message;
  }

  console.log('iCal sync complete:', results);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, ...results }),
  };
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
    const checkIn   = (r.checkIn  || '').split('T')[0];
    const checkOut  = (r.checkOut || '').split('T')[0];
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
    .is('guest_email', null);

    if (!error) enriched++;
  }
  return enriched;
}

// ── iCal fetcher ─────────────────────────────────────────────────────────────

async function fetchAndParseICal(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return parseICal(text);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── iCal parser (extended from ical-fetch.js — adds UID + SUMMARY) ──────────

function parseICal(text) {
  const events = [];
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\r|\n/);

  let inEvent = false;
  let dtstart = null, dtend = null, uid = null, summary = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      dtstart = dtend = uid = summary = null;
    } else if (line === 'END:VEVENT') {
      if (inEvent && dtstart && dtend) {
        events.push({ start: dtstart, end: dtend, uid, summary });
      }
      inEvent = false;
    } else if (inEvent) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).split(';')[0].toUpperCase();
      const val = line.slice(colon + 1).trim();

      if      (key === 'DTSTART')  dtstart = toDateStr(val);
      else if (key === 'DTEND')    dtend   = toDateStr(val);
      else if (key === 'UID')      uid     = val;
      else if (key === 'SUMMARY')  summary = val;
    }
  }

  return events;
}

function toDateStr(val) {
  const d = val.replace(/T[\d]{6}Z?$/, '').replace(/Z$/, '');
  if (d.length === 8) {
    return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  }
  return d;
}
