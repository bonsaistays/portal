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

  const { items, success_url, cancel_url } = body;

  if (!items || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No items provided' }) };
  }

  // Build line items — prefer Stripe Price IDs if set, otherwise use price_data
  const line_items = items.map(item => {
    if (item.price_id) {
      // Pre-configured Stripe Price (recommended for recurring / managed pricing)
      return { price: item.price_id, quantity: item.qty };
    }
    // Fallback: dynamic price data (good for ad-hoc / custom prices)
    return {
      quantity: item.qty,
      price_data: {
        currency: 'cad',
        unit_amount: Math.round(Number(item.price) * 100), // cents
        product_data: { name: item.name },
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
