// Bonsai Stays — iCal Proxy Function
// Fetches one or more iCal feeds and returns merged blocked date ranges.
// Usage: /.netlify/functions/ical-fetch?urls=URL1,URL2,...
//
// iCal URLs cannot be fetched directly from the browser due to CORS.
// This function runs server-side on Netlify and returns JSON.

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const rawUrls = event.queryStringParameters?.urls || '';
  const urls = rawUrls.split(',').map(u => u.trim()).filter(u => u.startsWith('http'));

  if (!urls.length) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'No valid URLs provided', blocked: [] }),
    };
  }

  const allBlocked = [];

  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return;
        const text = await res.text();
        allBlocked.push(...parseICal(text));
      } catch (e) {
        console.error('iCal fetch failed:', url.slice(0, 80), e.message);
      }
    })
  );

  // Deduplicate and sort
  const seen = new Set();
  const unique = allBlocked
    .filter(b => {
      const key = `${b.start}|${b.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start.localeCompare(b.start));

  return {
    statusCode: 200,
    headers: { ...CORS, 'Cache-Control': 'public, max-age=900' }, // 15 min cache
    body: JSON.stringify({ blocked: unique }),
  };
};

// ── iCal Parser ──────────────────────────────────────────────────────────────

function parseICal(text) {
  const events = [];
  // Unfold continuation lines (iCal wraps long lines with CRLF + whitespace)
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\r|\n/);

  let inEvent = false;
  let dtstart = null;
  let dtend = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      dtstart = null;
      dtend = null;
    } else if (line === 'END:VEVENT') {
      if (inEvent && dtstart && dtend) {
        events.push({ start: dtstart, end: dtend });
      }
      inEvent = false;
    } else if (inEvent) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      // Key can have params like DTSTART;TZID=America/Toronto — strip params
      const key = line.slice(0, colon).split(';')[0].toUpperCase();
      const val = line.slice(colon + 1).trim();

      if (key === 'DTSTART') dtstart = toDateStr(val);
      else if (key === 'DTEND') dtend = toDateStr(val);
    }
  }

  return events;
}

function toDateStr(val) {
  // Strip time component and timezone suffix
  // Handles: 20260601, 20260601T150000Z, 20260601T150000
  const d = val.replace(/T[\d]{6}Z?$/, '').replace(/Z$/, '');
  if (d.length === 8) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  return d; // already formatted or unknown
}
