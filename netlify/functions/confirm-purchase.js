/**
 * Bonsai Stays — Confirm Purchase Payment
 * POST { purchase_id, session_id }
 *
 * Verifies the Stripe Checkout Session was paid and marks the purchase as paid.
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

  const { purchase_id, session_id } = body;

  if (!purchase_id || !session_id)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'purchase_id and session_id are required' }) };

  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };

  const sbH = {
    apikey:         SB_KEY,
    Authorization:  `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Verify payment with Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid')
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Payment not completed' }) };

    // Verify session belongs to this purchase
    if (session.metadata?.purchase_id !== purchase_id)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Session does not match purchase' }) };

    // 2. Mark purchase as paid (idempotent)
    const updateRes = await fetch(
      `${SB_URL}/rest/v1/purchases?id=eq.${encodeURIComponent(purchase_id)}`,
      {
        method:  'PATCH',
        headers: { ...sbH, Prefer: 'return=minimal' },
        body:    JSON.stringify({ status: 'paid' }),
      }
    );

    if (!updateRes.ok) {
      const t = await updateRes.text();
      throw new Error('Failed to update purchase: ' + t.slice(0, 200));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ confirmed: true }) };

  } catch (e) {
    console.error('confirm-purchase error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
