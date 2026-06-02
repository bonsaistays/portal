/**
 * Bonsai Stays — Guest Message SMS Notification
 * Netlify function: /.netlify/functions/notify-message
 *
 * Called by a Supabase Database Webhook whenever a row is inserted
 * into the `messages` table with sender = 'guest'.
 *
 * Sends an SMS to the admin via Twilio so you never miss a message.
 *
 * ── Required env vars (Netlify → Site settings → Environment variables) ───
 *
 *  TWILIO_ACCOUNT_SID   — from twilio.com/console
 *  TWILIO_AUTH_TOKEN    — from twilio.com/console
 *  TWILIO_FROM_NUMBER   — your Twilio phone number (e.g. +16135550100)
 *  NOTIFY_PHONE_TO      — your mobile number to receive alerts (e.g. +16135559999)
 *  SUPABASE_URL         — your Portal Supabase project URL
 *  SUPABASE_SERVICE_KEY — service role key (to look up booking + property)
 *
 * ── Optional ──────────────────────────────────────────────────────────────
 *
 *  WEBHOOK_SECRET       — if set, Supabase webhook must send this as
 *                         the x-webhook-secret header
 */

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  // ── Only accept POST ───────────────────────────────────────────────────
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
  // Supabase sends: { type: 'INSERT', table: 'messages', record: {...} }
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const record = payload.record || payload;
  const { booking_id, sender, content } = record;

  // Only notify on guest messages
  if (sender !== 'guest') {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'not a guest message' }) };
  }

  if (!content || !booking_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing content or booking_id' }) };
  }

  // ── Look up booking + property for context ────────────────────────────
  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  let guestName    = 'A guest';
  let propertyName = 'your property';

  if (SB_KEY) {
    try {
      const res  = await fetch(
        `${SB_URL}/rest/v1/bookings?id=eq.${booking_id}&select=guest_name,properties(name)`,
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
        guestName    = rows[0].guest_name       || guestName;
        propertyName = rows[0].properties?.name || propertyName;
      }
    } catch (e) {
      console.warn('Could not look up booking:', e.message);
      // Non-fatal — still send the SMS without enriched context
    }
  }

  // ── Build SMS ──────────────────────────────────────────────────────────
  // Keep it short and actionable — one glance should tell you everything
  const maxLen    = 280; // keep well under Twilio's segment limit
  const truncated = content.length > maxLen ? content.slice(0, maxLen) + '…' : content;

  const smsBody = [
    `🌿 Bonsai Stays`,
    `${guestName} @ ${propertyName}:`,
    `"${truncated}"`,
    `Reply in portal: bonsaistays.com/portal/booking.html?id=${booking_id}`,
  ].join('\n');

  // ── Send via Twilio ────────────────────────────────────────────────────
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const toNumber   = process.env.NOTIFY_PHONE_TO;

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    console.error('Missing Twilio env vars');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'SMS not configured — check Twilio env vars' }) };
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

    console.log('SMS sent:', result.sid);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sms_sid: result.sid }) };

  } catch (e) {
    console.error('Fetch error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
