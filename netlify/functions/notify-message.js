/**
 * Bonsai Stays — Guest Message Email Notification
 * Netlify function: /.netlify/functions/notify-message
 *
 * Called by a Supabase Database Webhook whenever a row is inserted
 * into the `messages` table with sender = 'guest'.
 *
 * Sends an email to the admin via Resend so you never miss a message.
 *
 * ── Required env vars (Netlify → Site settings → Environment variables) ───
 *
 *  RESEND_API_KEY        — from resend.com → API Keys
 *  NOTIFY_EMAIL_TO       — your email address (e.g. daniel@bonsaistays.com)
 *  NOTIFY_EMAIL_FROM     — verified sender (e.g. noreply@bonsaistays.com)
 *  SUPABASE_URL          — your Portal Supabase project URL
 *  SUPABASE_SERVICE_KEY  — service role key (to look up booking + property)
 *
 * ── Optional ──────────────────────────────────────────────────────────────
 *
 *  WEBHOOK_SECRET        — if set, the Supabase webhook must send this value
 *                          as the `x-webhook-secret` header
 */

const RESEND_API = 'https://api.resend.com/emails';

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
  // Supabase sends: { type: 'INSERT', table: 'messages', record: {...}, old_record: null }
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const record = payload.record || payload; // handle both envelope and raw formats
  const { booking_id, sender, content, created_at } = record;

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
  let bookingUrl   = `https://bonsaistays.com/portal/booking.html?id=${booking_id}`;

  if (SB_KEY) {
    try {
      const res = await fetch(
        `${SB_URL}/rest/v1/bookings?id=eq.${booking_id}&select=guest_name,id,properties(name)`,
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
        const b = rows[0];
        guestName    = b.guest_name  || guestName;
        propertyName = b.properties?.name || propertyName;
      }
    } catch (e) {
      console.warn('Could not look up booking:', e.message);
      // Non-fatal — still send the email without enriched context
    }
  }

  // ── Build email ────────────────────────────────────────────────────────
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const emailTo      = process.env.NOTIFY_EMAIL_TO;
  const emailFrom    = process.env.NOTIFY_EMAIL_FROM || 'Bonsai Stays <noreply@bonsaistays.com>';

  if (!RESEND_KEY || !emailTo) {
    console.error('Missing RESEND_API_KEY or NOTIFY_EMAIL_TO');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email not configured' }) };
  }

  const sentAt    = created_at ? new Date(created_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto' }) : 'just now';
  const firstName = guestName.split(' ')[0];

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F0;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <!-- Header -->
          <tr>
            <td style="background:#0B2218;border-radius:12px 12px 0 0;padding:24px 32px;text-align:center;">
              <div style="font-size:1.5rem;font-weight:700;color:#fff;letter-spacing:-0.5px;">🌿 Bonsai Stays</div>
              <div style="font-size:0.8rem;color:rgba(255,255,255,0.55);margin-top:4px;">Guest Message Alert</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:32px;">
              <p style="font-size:1rem;font-weight:600;color:#0B2218;margin:0 0 6px;">New message from ${guestName}</p>
              <p style="font-size:0.85rem;color:#6B7280;margin:0 0 24px;">📍 ${propertyName} &nbsp;·&nbsp; ${sentAt}</p>

              <!-- Message bubble -->
              <div style="background:#F0FDF4;border-left:4px solid #3D8B62;border-radius:0 10px 10px 0;padding:16px 20px;margin-bottom:28px;">
                <p style="font-size:0.95rem;color:#0B2218;line-height:1.6;margin:0;">${content.replace(/\n/g, '<br/>')}</p>
              </div>

              <a href="${bookingUrl}"
                 style="display:inline-block;background:#0B2218;color:#ffffff;font-size:0.88rem;font-weight:700;padding:13px 24px;border-radius:8px;text-decoration:none;">
                Reply to ${firstName} →
              </a>

              <p style="font-size:0.78rem;color:#9CA3AF;margin:24px 0 0;line-height:1.5;">
                This message was sent through the Bonsai Stays guest app.<br/>
                Reply directly in the portal — the guest will see your response in real time.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#F9F9F7;border-radius:0 0 12px 12px;padding:16px 32px;border-top:1px solid #E5E5E0;">
              <p style="font-size:0.75rem;color:#9CA3AF;margin:0;text-align:center;">
                Bonsai Stays · Muskoka, Ontario &nbsp;·&nbsp;
                <a href="https://bonsaistays.com/portal/dashboard.html" style="color:#3D8B62;text-decoration:none;">Open portal</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // ── Send via Resend ────────────────────────────────────────────────────
  try {
    const res = await fetch(RESEND_API, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    emailFrom,
        to:      [emailTo],
        subject: `💬 New message from ${guestName} — ${propertyName}`,
        html:    emailHtml,
      }),
    });

    const result = await res.json();

    if (!res.ok) {
      console.error('Resend error:', result);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email send failed', detail: result }) };
    }

    console.log('Email sent:', result.id);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, email_id: result.id }) };

  } catch (e) {
    console.error('Fetch error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
