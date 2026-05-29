// Netlify Function — create-checkout-session.js
// Creates a Stripe Checkout Session and returns the redirect URL.
//
// Required environment variable in Netlify dashboard:
//   STRIPE_SECRET_KEY  →  your Stripe secret key (sk_live_... or sk_test_...)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { items, success_url, cancel_url, discount_percent } = body;

  if (!items || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No items provided' }) };
  }

  // Apply partner discount if provided (0-100 percent)
  const discountMultiplier = (discount_percent > 0 && discount_percent <= 100)
    ? (1 - discount_percent / 100)
    : 1;

  // Build line items — always use price_data so we can apply discounts
  const line_items = items.map(item => {
    const basePrice = Math.round(Number(item.price) * 100); // cents
    const finalPrice = Math.round(basePrice * discountMultiplier);
    const nameSuffix = discount_percent > 0 ? ` (${discount_percent}% partner discount)` : '';
    return {
      quantity: item.qty,
      price_data: {
        currency: 'cad',
        unit_amount: finalPrice,
        product_data: { name: item.name + nameSuffix },
      },
    };
  });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || 'https://bonsaistays.com/guests/shop.html?order=success',
      cancel_url:  cancel_url  || 'https://bonsaistays.com/guests/shop.html?order=cancelled',
      shipping_address_collection: { allowed_countries: ['CA'] },
      billing_address_collection: 'auto',
      payment_method_types: ['card'],
      metadata: { source: 'bonsai_shop' },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
