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

          const status = ev.start <= today && ev.end >= today ? 'active' : 'upcoming';
          allRecs.push({
            property_id: prop.id,
            ical_uid:    ev.uid,
            check_in:    ev.start,
            check_out:   ev.end,
            guest_name:  `${platform} Reservation`,
            source:      'ical',
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

  console.log('iCal sync complete:', results);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, ...results }),
  };
};

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
