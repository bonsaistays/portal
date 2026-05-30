/**
 * Service Availability — Bonsai Stays
 * Parses a provider's iCal feed and returns available time slots for a given date.
 *
 * POST body:
 *   icalUrl         — provider's iCal calendar URL
 *   date            — requested date (YYYY-MM-DD)
 *   durationMinutes — session length in minutes (default 60)
 *   workingStart    — start of working hours, 24h (default "09:00")
 *   workingEnd      — end of working hours, 24h (default "18:00")
 */

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    icalUrl,
    date,
    durationMinutes = 60,
    workingStart    = '09:00',
    workingEnd      = '18:00',
  } = body;

  if (!date) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'date is required' }) };
  }

  // If no iCal URL, return all slots as available
  let busyTimes = [];
  if (icalUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(icalUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        busyTimes = parseICalTimes(text);
      }
    } catch (e) {
      console.warn('iCal fetch failed, returning all slots available:', e.message);
      // Don't fail — just show all slots as available if calendar unreachable
    }
  }

  const slots = generateSlots(date, durationMinutes, workingStart, workingEnd, busyTimes);

  return {
    statusCode: 200,
    headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }, // 5 min cache
    body: JSON.stringify({ date, slots }),
  };
};

/* ─── iCal parser (with full datetime support) ─────────────────────────── */

function parseICalTimes(text) {
  const busy = [];
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\r|\n/);

  let inEvent = false;
  let dtstart = null;
  let dtend   = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true; dtstart = null; dtend = null;
    } else if (line === 'END:VEVENT') {
      if (inEvent && dtstart && dtend) busy.push({ start: dtstart, end: dtend });
      inEvent = false;
    } else if (inEvent) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).split(';')[0].toUpperCase();
      const val = line.slice(colon + 1).trim();
      if (key === 'DTSTART') dtstart = parseDateTime(val);
      else if (key === 'DTEND') dtend = parseDateTime(val);
    }
  }

  return busy;
}

function parseDateTime(val) {
  // All-day: 20260601
  // With time (local): 20260601T150000
  // With time (UTC): 20260601T150000Z
  if (!val.includes('T')) {
    const y = +val.slice(0, 4), mo = +val.slice(4, 6) - 1, d = +val.slice(6, 8);
    return new Date(y, mo, d, 0, 0, 0);
  }
  const y   = +val.slice(0, 4);
  const mo  = +val.slice(4, 6) - 1;
  const d   = +val.slice(6, 8);
  const h   = +val.slice(9, 11);
  const min = +val.slice(11, 13);
  const sec = +val.slice(13, 15);
  if (val.endsWith('Z')) return new Date(Date.UTC(y, mo, d, h, min, sec));
  return new Date(y, mo, d, h, min, sec);
}

/* ─── Slot generator ────────────────────────────────────────────────────── */

function generateSlots(dateStr, durationMinutes, workingStart, workingEnd, busyTimes) {
  const [y, mo, d]      = dateStr.split('-').map(Number);
  const [sh, sm]        = workingStart.split(':').map(Number);
  const [eh, em]        = workingEnd.split(':').map(Number);

  const dayStart = new Date(y, mo - 1, d, sh, sm);
  const dayEnd   = new Date(y, mo - 1, d, eh, em);

  const slots = [];
  let cur = new Date(dayStart);

  while (cur < dayEnd) {
    const slotEnd = new Date(cur.getTime() + durationMinutes * 60_000);
    if (slotEnd > dayEnd) break;

    const available = !busyTimes.some(bt => cur < bt.end && slotEnd > bt.start);

    slots.push({ time: formatTime(cur), value: cur.toTimeString().slice(0, 5), available });
    cur = slotEnd;
  }

  return slots;
}

function formatTime(date) {
  let h = date.getHours(), m = date.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
}
