// generate-access-code.js
// Calls Seam API to create a time-limited PIN code for a smart lock,
// then saves it to the bookings table in Supabase.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const SEAM_API_KEY   = process.env.SEAM_API_KEY;
  const SUPABASE_URL   = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SEAM_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SEAM_API_KEY not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { device_id, booking_id, guest_name, check_in, check_out } = body;

  if (!device_id || !booking_id || !check_in || !check_out) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: device_id, booking_id, check_in, check_out' }) };
  }

  // ── 1. Create access code via Seam ──────────────────────────────────────
  let seamRes, seamData;
  try {
    seamRes = await fetch('https://connect.getseam.com/access_codes/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SEAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_id,
        name: `Guest${guest_name ? ' - ' + guest_name : ''} (${booking_id.slice(0, 8)})`,
        starts_at: new Date(check_in).toISOString(),
        ends_at:   new Date(check_out).toISOString(),
      }),
    });
    seamData = await seamRes.json();
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Cannot reach Seam API: ' + err.message }) };
  }

  if (!seamRes.ok) {
    return {
      statusCode: seamRes.status,
      body: JSON.stringify({ error: 'Seam error: ' + (seamData?.error?.message || JSON.stringify(seamData)) }),
    };
  }

  const pin = seamData?.access_code?.code;
  if (!pin) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Seam did not return a PIN code', raw: seamData }) };
  }

  // ── 2. Save PIN to Supabase bookings table ───────────────────────────────
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.${encodeURIComponent(booking_id)}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ door_code: pin }),
      });
    } catch (err) {
      // Non-fatal — return the PIN even if DB save fails
      console.error('Supabase save failed:', err.message);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, pin }),
  };
};
