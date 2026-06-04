/**
 * Bonsai Stays — Verify Member OTP
 * Netlify function: /.netlify/functions/member-verify-otp
 *
 * POST { email, code } → validates the OTP and returns member points info
 *
 * Returns:
 *   { verified: true, member_id, name, points, tier }
 *   { verified: false, error: "Invalid or expired code" }
 */

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let email, code;
  try { ({ email, code } = JSON.parse(event.body || '{}')); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!email || !code)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email and code required' }) };

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server config error' }) };

  // ── Look up member ────────────────────────────────────────────────────
  const mRes  = await fetch(
    `${SB_URL}/rest/v1/members?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id,first_name,name,points,tier&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' } }
  );
  const mRows = await mRes.json();

  if (!Array.isArray(mRows) || !mRows.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, error: 'Member not found' }) };
  }

  const member = mRows[0];

  // ── Look up OTP ───────────────────────────────────────────────────────
  const now    = new Date().toISOString();
  const otpRes = await fetch(
    `${SB_URL}/rest/v1/member_otps?member_id=eq.${member.id}&code=eq.${encodeURIComponent(code)}&used=eq.false&expires_at=gt.${encodeURIComponent(now)}&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' } }
  );
  const otpRows = await otpRes.json();

  if (!Array.isArray(otpRows) || !otpRows.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ verified: false, error: 'Invalid or expired code. Please try again.' }) };
  }

  // ── Mark OTP as used ─────────────────────────────────────────────────
  await fetch(`${SB_URL}/rest/v1/member_otps?id=eq.${otpRows[0].id}`, {
    method:  'PATCH',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body:    JSON.stringify({ used: true }),
  });

  const firstName = member.first_name || (member.name || '').split(' ')[0] || 'there';

  console.log(`OTP verified for member ${member.id}`);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      verified:  true,
      member_id: member.id,
      name:      firstName,
      points:    member.points || 0,
      tier:      member.tier   || 'Black',
    }),
  };
};
