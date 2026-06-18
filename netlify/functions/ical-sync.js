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

  const results = { synced: 0, skipped: 0, errors: [] };

  for (const prop of properties || []) {
    const icalUrls = Array.isArray(prop.ical_urls) ? prop.ical_urls : [];

    for (const entry of icalUrls) {
      const url      = typeof entry === 'string' ? entry : entry?.url;
      const platform = typeof entry === 'object'  ? (entry?.platform || 'iCal') : 'iCal';

      if (!url || !url.startsWith('http')) continue;

      try {
        const events = await fetchAndParseICal(url);

        for (const ev of events) {
          if (!ev.start || !ev.end) continue;

          // Skip events entirely in the past
          if (new Date(ev.end) < new Date()) continue;

          const today    = new Date().toISOString().split('T')[0];
          const status   = ev.start <= today && ev.end >= today ? 'active' : 'upcoming';
          const guestName = `${platform} Reservation`;

          // Build upsert record
          const record = {
            property_id: prop.id,
            check_in:    ev.start,
            check_out:   ev.end,
            guest_name:  guestName,
            source:      'ical',
            status,
            ical_uid:    ev.uid || null,
          };

          // Upsert: match on ical_uid if we have one, else property+dates
          let upsertError;
          if (ev.uid) {
            const { error } = await sb
              .from('bookings')
              .upsert(record, { onConflict: 'ical_uid', ignoreDuplicates: false });
            upsertError = error;
          } else {
            // No UID — check if a matching booking already exists
            const { data: existing } = await sb
              .from('bookings')
              .select('id')
              .eq('property_id', prop.id)
              .eq('check_in',    ev.start)
              .eq('check_out',   ev.end)
              .eq('source',      'ical')
              .maybeSingle();

            if (existing) {
              // Update status only
              const { error } = await sb
                .from('bookings')
                .update({ status })
                .eq('id', existing.id);
              upsertError = error;
            } else {
              const { error } = await sb.from('bookings').insert(record);
              upsertError = error;
            }
          }

          if (upsertError) {
            results.errors.push(`${prop.name} [${platform}]: ${upsertError.message}`);
          } else {
            results.synced++;
          }
        }
      } catch (e) {
        results.errors.push(`${prop.name} [${platform}] fetch failed: ${e.message}`);
      }
    }
    // Stamp last_synced_at per property
    await sb.from('properties').update({ last_synced_at: new Date().toISOString() }).eq('id', prop.id);
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
