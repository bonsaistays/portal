/**
 * Bonsai Stays — Submit Booking Request
 * POST { property_id, guest_name, guest_email, guest_phone,
 *         check_in, check_out, num_adults, num_children,
 *         screener_answers, special_requests, extras }
 *
 * Inserts a row into `booking_requests` (status = 'pending')
 * and fires an SMS to the Bonsai Stays team via Twilio.
 *
 * Required env vars:
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / NOTIFY_PHONE_TO
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    property_id, guest_name, guest_email, guest_phone,
    check_in, check_out, num_adults = 2, num_children = 0,
    screener_answers = {}, special_requests = '', extras = [],
  } = body;

  if (!property_id || !guest_name || !guest_email || !check_in || !check_out) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };

  const sb = createClient(SB_URL, SB_KEY);

  // ── Look up property name ──────────────────────────────────────────────
  const { data: prop } = await sb
    .from('properties')
    .select('name')
    .eq('id', property_id)
    .single();

  const propertyName = prop?.name || 'a property';

  // ── Insert booking request ─────────────────────────────────────────────
  const { data: request, error: insertErr } = await sb
    .from('booking_requests')
    .insert({
      property_id,
      guest_name,
      guest_email,
      guest_phone:       guest_phone || null,
      check_in,
      check_out,
      num_adults,
      num_children,
      screener_answers,
      special_requests:  special_requests || null,
      extras:            extras.length ? extras.join(', ') : null,
      status:            'pending',
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error('Insert error:', insertErr.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save request' }) };
  }

  // ── Build SMS ──────────────────────────────────────────────────────────
  const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  const nights  = Math.round((new Date(check_out) - new Date(check_in)) / 86400000);

  const lines = [
    `🌿 New Booking Request — Bonsai Stays`,
    `Guest: ${guest_name}`,
    `Property: ${propertyName}`,
    `Dates: ${fmtDate(check_in)} → ${fmtDate(check_out)} (${nights} night${nights !== 1 ? 's' : ''})`,
    `Guests: ${num_adults} adult${num_adults !== 1 ? 's' : ''}${num_children > 0 ? `, ${num_children} child${num_children !== 1 ? 'ren' : ''}` : ''}`,
  ];

  if (guest_email) lines.push(`Email: ${guest_email}`);
  if (guest_phone) lines.push(`Phone: ${guest_phone}`);

  const answers = Object.entries(screener_answers);
  if (answers.length) {
    lines.push('');
    lines.push('Screener answers:');
    answers.forEach(([q, a]) => lines.push(`• ${q}: ${a}`));
  }

  if (special_requests) lines.push(`Notes: ${special_requests}`);
  if (extras?.length)   lines.push(`Extras: ${extras.join(', ')}`);

  lines.push('');
  lines.push(`Review: bonsaistays.com/portal/dashboard.html#requests`);

  const smsBody = lines.join('\n');

  // ── Send SMS via Twilio ────────────────────────────────────────────────
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const toNumber   = process.env.NOTIFY_PHONE_TO;

  if (accountSid && authToken && fromNumber && toNumber) {
    try {
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method:  'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: fromNumber, To: toNumber, Body: smsBody }).toString(),
      });
    } catch (e) {
      console.warn('SMS send failed (non-fatal):', e.message);
    }
  } else {
    console.warn('Twilio env vars not set — SMS skipped');
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, request_id: request.id }),
  };
};
