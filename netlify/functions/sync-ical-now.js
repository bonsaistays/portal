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

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...results }) };
};

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
  let inEvent = false, dtstart = null, dtend = null, uid = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; dtstart = dtend = uid = null; }
    else if (line === 'END:VEVENT') {
      if (inEvent && dtstart && dtend) events.push({ start: dtstart, end: dtend, uid });
      inEvent = false;
    } else if (inEvent) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).split(';')[0].toUpperCase();
      const val = line.slice(colon + 1).trim();
      if      (key === 'DTSTART') dtstart = toDateStr(val);
      else if (key === 'DTEND')   dtend   = toDateStr(val);
      else if (key === 'UID')     uid     = val;
    }
  }
  return events;
}

function toDateStr(val) {
  const d = val.replace(/T[\d]{6}Z?$/, '').replace(/Z$/, '');
  return d.length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : d;
}
