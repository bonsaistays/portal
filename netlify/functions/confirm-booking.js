/**
 * Bonsai Stays — Confirm Booking
 * POST { booking_id, session_id }
 *
 * Verifies the Stripe Checkout Session was paid, marks the booking as confirmed,
 * deducts any redeemed loyalty points, and sends the host an SMS notification.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY     — Stripe secret key
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase service role key
 *   TWILIO_ACCOUNT_SID    — (optional) for host SMS notification
 *   TWILIO_AUTH_TOKEN     — (optional)
 *   TWILIO_FROM_NUMBER    — (optional)
 *   NOTIFY_PHONE_TO       — (optional) host's phone number
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { booking_id, session_id } = body;

  if (!booking_id || !session_id)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'booking_id and session_id are required' }) };

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };

  const sbHeaders = {
    apikey:         SB_KEY,
    Authorization:  `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Verify payment with Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Payment not completed', payment_status: session.payment_status }),
      };
    }

    // Verify the session belongs to this booking (prevents spoofing)
    if (session.metadata?.booking_id !== booking_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Session does not match booking' }) };
    }

    // 2. Fetch booking record
    const bookingRes = await fetch(
      `${SB_URL}/rest/v1/bookings?id=eq.${encodeURIComponent(booking_id)}&select=*&limit=1`,
      { headers: sbHeaders }
    );
    const bookings = await bookingRes.json();

    if (!Array.isArray(bookings) || bookings.length === 0)
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };

    const booking = bookings[0];

    // Idempotency — already confirmed (e.g. page refreshed)
    if (booking.status === 'confirmed') {
      return { statusCode: 200, headers, body: JSON.stringify({ confirmed: true, already_confirmed: true }) };
    }

    // 3. Mark booking confirmed
    const updateRes = await fetch(
      `${SB_URL}/rest/v1/bookings?id=eq.${encodeURIComponent(booking_id)}`,
      {
        method:  'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body:    JSON.stringify({ status: 'confirmed' }),
      }
    );
    if (!updateRes.ok) {
      const t = await updateRes.text();
      throw new Error('Failed to confirm booking: ' + t.slice(0, 200));
    }

    // 4. Deduct redeemed loyalty points
    if (booking.member_id && booking.points_redeemed > 0) {
      const memRes = await fetch(
        `${SB_URL}/rest/v1/members?id=eq.${encodeURIComponent(booking.member_id)}&select=points&limit=1`,
        { headers: sbHeaders }
      );
      const members = await memRes.json();

      if (Array.isArray(members) && members.length > 0) {
        const newPoints = Math.max(0, (members[0].points || 0) - booking.points_redeemed);

        await fetch(
          `${SB_URL}/rest/v1/members?id=eq.${encodeURIComponent(booking.member_id)}`,
          { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ points: newPoints }) }
        );

        await fetch(`${SB_URL}/rest/v1/points_history`, {
          method:  'POST',
          headers: sbHeaders,
          body:    JSON.stringify({
            member_id:   booking.member_id,
            points:      -booking.points_redeemed,
            description: `Redeemed on booking (check-in ${booking.check_in?.split('T')[0]})`,
            booking_id,
          }),
        });
      }
    }

    // 5. Notify host via SMS
    const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const TWILIO_FROM  = process.env.TWILIO_FROM_NUMBER;
    const NOTIFY_TO    = process.env.NOTIFY_PHONE_TO;

    if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && NOTIFY_TO && TWILIO_FROM !== 'PENDING') {
      // Look up property name
      const propRes = await fetch(
        `${SB_URL}/rest/v1/properties?id=eq.${encodeURIComponent(booking.property_id)}&select=name&limit=1`,
        { headers: sbHeaders }
      );
      const props    = await propRes.json();
      const propName = props[0]?.name || booking.property_id;

      const msgLines = [
        `✅ NEW CONFIRMED BOOKING — ${propName}`,
        `Guest: ${booking.guest_name}`,
        `Dates: ${booking.check_in?.split('T')[0]} → ${booking.check_out?.split('T')[0]}`,
        `Guests: ${booking.num_guests}`,
        `Contact: ${booking.guest_email}${booking.guest_phone ? ' · ' + booking.guest_phone : ''}`,
        booking.points_redeemed > 0 ? `Points redeemed: ${booking.points_redeemed}` : null,
        `Portal: https://bonsaistays.com/app/`,
      ].filter(Boolean).join('\n');

      await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method:  'POST',
          headers: {
            Authorization:  'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: NOTIFY_TO, From: TWILIO_FROM, Body: msgLines }).toString(),
        }
      ).catch(e => console.warn('SMS notification skipped:', e.message));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ confirmed: true }) };

  } catch (e) {
    console.error('confirm-booking error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
