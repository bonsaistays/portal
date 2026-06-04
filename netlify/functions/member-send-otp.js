/**
 * Bonsai Stays — Send Member OTP
 * Netlify function: /.netlify/functions/member-send-otp
 *
 * POST { email } → generates a 6-digit code, stores it in member_otps
 * (expires in 10 min), and sends it to the member's phone via Twilio.
 *
 * Returns:
 *   { sent: true, hint: "+1 (416) ***-**35" }  — masked phone for display
 *   { sent: false, error: "No phone on file" }
 */

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let email;
  try { ({ email } = JSON.parse(event.body || '{}')); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email required' }) };

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server config error' }) };

  // ── Look up member ────────────────────────────────────────────────────
  const mRes  = await fetch(
    `${SB_URL}/rest/v1/members?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id,phone&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' } }
  );
  const mRows = await mRes.json();

  if (!Array.isArray(mRows) || !mRows.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ sent: false, error: 'No member account found' }) };
  }

  const member = mRows[0];
  const phone  = member.phone;

  if (!phone) {
    return { statusCode: 200, headers, body: JSON.stringify({ sent: false, error: 'No phone number on file for this account. Contact us to apply your points.' }) };
  }

  // ── Generate 6-digit code ─────────────────────────────────────────────
  const code      = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  // ── Store in member_otps (invalidate any existing unused codes first) ─
  await fetch(`${SB_URL}/rest/v1/member_otps?member_id=eq.${member.id}&used=eq.false`, {
    method:  'PATCH',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body:    JSON.stringify({ used: true }),
  });

  const insertRes = await fetch(`${SB_URL}/rest/v1/member_otps`, {
    method:  'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body:    JSON.stringify({ member_id: member.id, code, expires_at: expiresAt, used: false }),
  });

  if (!insertRes.ok) {
    const err = await insertRes.text();
    console.error('OTP insert error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create verification code' }) };
  }

  // ── Send SMS via Twilio ───────────────────────────────────────────────
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  // Twilio not yet configured — bypass OTP and auto-verify by email match
  if (!accountSid || !authToken || !fromNumber || fromNumber === 'PENDING') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ sent: false, bypass: true, member_id: member.id }),
    };
  }

  const smsBody = `Your Bonsai Stays verification code is: ${code}\n\nExpires in 10 minutes. Do not share this code.`;
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth      = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  try {
    const smsRes = await fetch(twilioUrl, {
      method:  'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ From: fromNumber, To: phone, Body: smsBody }).toString(),
    });

    if (!smsRes.ok) {
      const err = await smsRes.json();
      console.error('Twilio error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to send SMS' }) };
    }
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }

  // Mask the phone number for display: +1 (416) 985-7135 → +1 (416) ***-**35
  const masked = phone.replace(/(\d)(?=\d{2,}$)/g, '*').replace(/\*+/, '***-**');

  console.log(`OTP sent to member ${member.id}`);
  return { statusCode: 200, headers, body: JSON.stringify({ sent: true, hint: masked }) };
};
