/**
 * Bonsai Stays — Create Booking Checkout
 * POST { guest_name, guest_email, guest_phone, property_id, check_in, check_out,
 *         num_guests, special_requests, extras, member_id, points_redeemed }
 *
 * Validates inputs, inserts booking as pending_payment, creates a Stripe Checkout
 * Session, and returns { url, booking_id } for client redirect.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY     — Stripe secret key
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase service role key (bypasses RLS)
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const REDEEM_RATE = { Black: 100, Gold: 90, Platinum: 75 };

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

  const {
    guest_name, guest_email, guest_phone,
    property_id, check_in, check_out,
    num_guests, special_requests, extras,
    member_id, points_redeemed,
  } = body;

  if (!guest_name || !guest_email || !property_id || !check_in || !check_out) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  if (!process.env.STRIPE_SECRET_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payment system not configured' }) };

  const sbHeaders = {
    apikey:        SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Look up property price
    const propRes = await fetch(
      `${SB_URL}/rest/v1/properties?id=eq.${encodeURIComponent(property_id)}&select=id,name,price&limit=1`,
      { headers: sbHeaders }
    );
    const props = await propRes.json();
    if (!Array.isArray(props) || props.length === 0)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Property not found' }) };

    const property = props[0];
    const nightlyRate = property.price;

    if (!nightlyRate || nightlyRate <= 0)
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Pricing is not yet available for this property. Please contact us to arrange your booking.' }),
      };

    // 2. Calculate nights and total
    const nights = Math.round((new Date(check_out) - new Date(check_in)) / 86400000);
    if (nights < 1)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Check-out must be after check-in' }) };

    let totalCents = Math.round(nights * nightlyRate * 100);

    // 3. Server-side points discount (re-verify member's actual balance and tier)
    let pointsDiscount = 0;
    const ptsToRedeem = parseInt(points_redeemed) || 0;

    if (member_id && ptsToRedeem > 0) {
      const memRes = await fetch(
        `${SB_URL}/rest/v1/members?id=eq.${encodeURIComponent(member_id)}&select=points,tier&limit=1`,
        { headers: sbHeaders }
      );
      const members = await memRes.json();
      if (Array.isArray(members) && members.length > 0) {
        const memberTier   = members[0].tier   || 'Black';
        const memberPoints = members[0].points || 0;
        const actualPts    = Math.min(ptsToRedeem, memberPoints); // can't redeem more than balance
        const rate         = REDEEM_RATE[memberTier] || 100;
        pointsDiscount     = Math.floor((actualPts / rate) * 100); // cents
      }
    }

    const finalCents = Math.max(totalCents - pointsDiscount, 100); // Stripe min $1.00

    // 4. Insert booking as pending_payment (service key bypasses RLS)
    const bookingPayload = {
      guest_name,
      guest_email:      guest_email.toLowerCase(),
      guest_phone:      guest_phone || null,
      property_id,
      check_in:         check_in  + 'T15:00:00',
      check_out:        check_out + 'T11:00:00',
      num_guests:       parseInt(num_guests) || 1,
      special_requests: special_requests || null,
      extras:           Array.isArray(extras) ? extras : [],
      status:           'pending_payment',
      member_id:        member_id || null,
      points_redeemed:  ptsToRedeem,
    };

    const insertRes = await fetch(`${SB_URL}/rest/v1/bookings`, {
      method:  'POST',
      headers: { ...sbHeaders, Prefer: 'return=representation' },
      body:    JSON.stringify(bookingPayload),
    });

    const insertText = await insertRes.text();
    if (!insertRes.ok) throw new Error('Booking save failed: ' + insertText.slice(0, 300));

    let inserted;
    try { inserted = JSON.parse(insertText); }
    catch { throw new Error('Unexpected response from booking save: ' + insertText.slice(0, 200)); }

    const bookingId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
    if (!bookingId) throw new Error('No booking ID returned — check Supabase bookings table schema');

    // 5. Create Stripe Checkout Session
    const baseUrl = 'https://bonsaistays.com/guests/book.html';
    const nightLabel  = `${nights} night${nights !== 1 ? 's' : ''}`;
    const dateRange   = `${check_in} → ${check_out}`;
    const pointsNote  = ptsToRedeem > 0 ? ` · ${ptsToRedeem.toLocaleString()} Bon Voyage points applied` : '';

    const session = await stripe.checkout.sessions.create({
      mode:                 'payment',
      payment_method_types: ['card'],
      customer_email:       guest_email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency:     'cad',
          unit_amount:  finalCents,
          product_data: {
            name:        `${property.name} — ${nightLabel}`,
            description: dateRange + pointsNote,
          },
        },
      }],
      success_url: `${baseUrl}?success=1&booking_id=${bookingId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}?cancelled=1&booking_id=${bookingId}`,
      metadata:    { booking_id: bookingId, source: 'bonsai_booking' },
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url, booking_id: bookingId }),
    };

  } catch (e) {
    console.error('create-booking-checkout error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
