/**
 * Bonsai Stays — Member Lookup
 * Netlify function: /.netlify/functions/member-lookup
 *
 * POST { email } → returns member info for loyalty display on book.html
 * Only returns first name, points, tier, and member_id — no PII beyond that.
 *
 * ── Required env vars ─────────────────────────────────────────────────────
 *  SUPABASE_URL          — Supabase project URL
 *  SUPABASE_SERVICE_KEY  — service role key
 */

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let email;
  try {
    ({ email } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!email || !email.includes('@')) {
    return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
  }

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server config error' }) };
  }

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/members?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id,name,points,tier&limit=1`,
      {
        headers: {
          apikey:        SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          Accept:        'application/json',
        },
      }
    );

    const rows = await res.json();

    if (!Array.isArray(rows) || rows.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
    }

    const m = rows[0];
    const firstName = (m.name || '').split(' ')[0] || 'there';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found:     true,
        member_id: m.id,
        name:      firstName,
        points:    m.points || 0,
        tier:      m.tier   || 'Black',
      }),
    };
  } catch (e) {
    console.error('member-lookup error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
