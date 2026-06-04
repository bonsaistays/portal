/**
 * Bonsai Stays — New Booking Inquiry SMS Notification
 * Netlify function: /.netlify/functions/notify-booking
 *
 * Called by a Supabase Database Webhook whenever a row is inserted
 * into the `bookings` table with status = 'inquiry'.
 *
 * Sends an SMS to the host so they can follow up within 24 hours.
 *
 * ── Supabase Database Webhook setup ───────────────────────────────────────
 *  Table:  bookings
 *  Events: INSERT
 *  URL:    https://bonsaistays.com/.netlify/functions/notify-booking
 *  (Add x-webhook-secret header if WEBHOOK_SECRET env var is set)
 *
 * ── Required env vars ─────────────────────────────────────────────────────
 *  TWILIO_ACCOUNT_SID   — from twilio.com/console
 *  TWILIO_AUTH_TOKEN    — from twilio.com/console
 *  TWILIO_FROM_NUMBER   — your Twilio phone number (e.g. +16135550100)
 *  NOTIFY_PHONE_TO      — your mobile number to receive alerts
 *  SUPABASE_URL         — Supabase project URL
 *  SUPABASE_SERVICE_KEY — service role key (to look up property name)
 *
 * ── Optional ──────────────────────────────────────────────────────────────
 *  WEBHOOK_SECRET       — shared secret sent as x-webhook-secret header
 */

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Optional webhook secret check ─────────────────────────────────────
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = event.headers?.['x-webhook-secret'] || event.headers?.['x-bonsai-secret'] || '';
    if (provided !== secret) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  // ── Parse Supabase webhook payload ────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const record = payload.record || payload;
  const { id, guest_name, guest_email, guest_phone, property_id, check_in, check_out, num_guests, status } = record;

  // Only notify on new inquiries
  if (status !== 'inquiry') {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'not an inquiry' }) };
  }

  // ── Look up property name ──────────────────────────────────────────────
  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  let propertyName = 'a property';

  if (SB_KEY && property_id) {
    try {
      const res  = await fetch(
        `${SB_URL}/rest/v1/properties?id=eq.${property_id}&select=name`,
        {
          headers: {
            apikey:        SB_KEY,
            Authorization: `Bearer ${SB_KEY}`,
            Accept:        'application/json',
          },
        }
      );
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        propertyName = rows[0].name || propertyName;
      }
    } catch (e) {
      console.warn('Could not look up property:', e.message);
    }
  }

  // ── Format dates ──────────────────────────────────────────────────────
  const fmtDate = d => {
    if (!d) return '?';
    return new Date(d + (d.includes('T') ? '' : 'T12:00:00')).toLocaleDateString('en-CA', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  };

  const nights = (check_in && check_out)
    ? Math.round((new Date(check_out) - new Date(check_in)) / 86400000)
    : null;

  // ── Build SMS ──────────────────────────────────────────────────────────
  const lines = [
    `🌿 New Booking Inquiry — Bonsai Stays`,
    `Guest: ${guest_name || 'Unknown'}`,
    `Property: ${propertyName}`,
    `Dates: ${fmtDate(check_in)} → ${fmtDate(check_out)}${nights ? ` (${nights} night${nights !== 1 ? 's' : ''})` : ''}`,
  ];
  if (num_guests) lines.push(`Guests: ${num_guests}`);
  if (guest_email) lines.push(`Email: ${guest_email}`);
  if (guest_phone) lines.push(`Phone: ${guest_phone}`);
  lines.push(`Review: bonsaistays.com/portal/booking.html?id=${id}`);

  const smsBody = lines.join('\n');

  // ── Send via Twilio ────────────────────────────────────────────────────
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const toNumber   = process.env.NOTIFY_PHONE_TO;

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    console.error('Missing Twilio env vars — SMS not sent');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'SMS not configured' }) };
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth      = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const body = new URLSearchParams({
    From: fromNumber,
    To:   toNumber,
    Body: smsBody,
  });

  try {
    const res = await fetch(twilioUrl, {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const result = await res.json();

    if (!res.ok) {
      console.error('Twilio error:', result);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'SMS send failed', detail: result }) };
    }

    console.log(`Booking inquiry SMS sent for booking ${id}: ${result.sid}`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sms_sid: result.sid }) };

  } catch (e) {
    console.error('Fetch error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
