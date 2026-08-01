/**
 * Bonsai Stays — Create Purchase Checkout
 * POST { purchase_id, booking_id, token }
 *
 * Verifies the booking token, looks up the purchase, and creates a Stripe
 * Checkout Session so the guest can pay for an extra/experience.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY    — Stripe secret key
 *   SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key
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

  const { purchase_id, booking_id, token } = body;

  if (!purchase_id || !booking_id || !token)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'purchase_id, booking_id and token are required' }) };

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  if (!process.env.STRIPE_SECRET_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payment system not configured' }) };

  const sbH = {
    apikey:         SB_KEY,
    Authorization:  `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Verify the token belongs to this booking
    const bookingRes = await fetch(
      `${SB_URL}/rest/v1/bookings?id=eq.${encodeURIComponent(booking_id)}&token=eq.${encodeURIComponent(token)}&select=id,guest_name,guest_email&limit=1`,
      { headers: sbH }
    );
    const bookings = await bookingRes.json();
    if (!Array.isArray(bookings) || bookings.length === 0)
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Invalid booking or token' }) };

    const bk = bookings[0];

    // 2. Look up the purchase
    const purchaseRes = await fetch(
      `${SB_URL}/rest/v1/purchases?id=eq.${encodeURIComponent(purchase_id)}&booking_id=eq.${encodeURIComponent(booking_id)}&select=*&limit=1`,
      { headers: sbH }
    );
    const purchases = await purchaseRes.json();
    if (!Array.isArray(purchases) || purchases.length === 0)
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Purchase not found' }) };

    const purchase = purchases[0];

    if (purchase.status === 'paid')
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Already paid' }) };

    if (!purchase.amount || purchase.amount <= 0)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No price set for this item yet — please wait for host confirmation' }) };

    // 3. Create Stripe Checkout Session
    const baseUrl = `https://bonsaistays.com/portal/guest/?token=${encodeURIComponent(token)}`;

    const session = await stripe.checkout.sessions.create({
      mode:                 'payment',
      payment_method_types: ['card'],
      customer_email:       bk.guest_email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency:     'cad',
          unit_amount:  purchase.amount, // already in cents
          product_data: { name: purchase.item_name },
        },
      }],
      success_url: `${baseUrl}&paid=1&purchase_id=${purchase_id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}&pay_cancelled=1`,
      metadata:    { purchase_id, booking_id, source: 'bonsai_purchase' },
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url }),
    };

  } catch (e) {
    console.error('create-purchase-checkout error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
