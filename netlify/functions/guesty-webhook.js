/**
 * Bonsai Stays — Guesty Reservation Webhook
 * Netlify function: /.netlify/functions/guesty-webhook
 *
 * Receives reservation events pushed by Guesty and upserts them
 * into the Supabase `bookings` table in real time.
 *
 * Set this URL in Guesty → Settings → Webhooks:
 *   https://bonsaistays.com/.netlify/functions/guesty-webhook
 *
 * Events handled:
 *   reservation.created   → insert booking
 *   reservation.updated   → update booking
 *   reservation.cancelled → mark booking cancelled
 *
 * ── Required env vars ─────────────────────────────────────────────────────
 *  SUPABASE_URL            — Portal Supabase project URL
 *  SUPABASE_SERVICE_KEY    — service role key
 *
 * ── Optional env vars ─────────────────────────────────────────────────────
 *  GUESTY_WEBHOOK_SECRET   — if set in Guesty, used to verify the
 *                            x-guesty-signature header
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Optional signature verification ───────────────────────────────────
  const webhookSecret = process.env.GUESTY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sig = event.headers?.['x-guesty-signature'] || '';
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(event.body || '')
      .digest('hex');
    if (sig !== expected && sig !== `sha256=${expected}`) {
      console.warn('Guesty webhook signature mismatch');
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
    }
  }

  // ── Parse payload ──────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const eventType   = payload.event || payload.type || '';
  const reservation = payload.data  || payload.reservation || payload;

  console.log('Guesty webhook received:', eventType);

  if (!eventType.includes('reservation')) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'not a reservation event' }) };
  }

  // ── Connect to Supabase ────────────────────────────────────────────────
  const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing SUPABASE_SERVICE_KEY' }) };
  }

  const sb = createClient(SB_URL, SB_KEY);

  // ── Map Guesty reservation to our bookings schema ─────────────────────
  const guestyId   = reservation._id || reservation.id;
  const listingId  = reservation.listingId || reservation.listing?._id;
  const status     = mapStatus(reservation.status, eventType);

  if (!guestyId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No reservation ID in payload' }) };
  }

  // Look up the property by Guesty listing ID
  let propertyId = null;
  if (listingId) {
    const { data: prop } = await sb
      .from('properties')
      .select('id')
      .eq('guesty_id', listingId)
      .maybeSingle();
    propertyId = prop?.id || null;
  }

  const checkIn  = (reservation.checkIn  || reservation.check_in  || '').split('T')[0];
  const checkOut = (reservation.checkOut || reservation.check_out || '').split('T')[0];

  const record = {
    guesty_reservation_id: guestyId,
    property_id:           propertyId,
    check_in:              checkIn  || null,
    check_out:             checkOut || null,
    status,
    guests:                reservation.guestsCount || reservation.guests || 1,
    guest_name:            buildGuestName(reservation),
    guest_email:           reservation.guest?.email   || reservation.guestEmail   || null,
    guest_phone:           reservation.guest?.phone   || reservation.guestPhone   || null,
    total_price:           parseMoney(reservation),
    confirmation_code:     reservation.confirmationCode || guestyId,
    source:                'guesty',
  };

  // ── Upsert ─────────────────────────────────────────────────────────────
  const { error } = await sb
    .from('bookings')
    .upsert(record, { onConflict: 'guesty_reservation_id' });

  if (error) {
    console.error('Supabase upsert error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }

  console.log(`Booking upserted for reservation ${guestyId} (${status})`);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, guesty_id: guestyId, status }),
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapStatus(guestyStatus, eventType) {
  if (eventType.includes('cancel') || guestyStatus === 'cancelled') return 'cancelled';
  switch ((guestyStatus || '').toLowerCase()) {
    case 'confirmed':   return 'upcoming';
    case 'reserved':    return 'upcoming';
    case 'checked_in':  return 'active';
    case 'checked_out': return 'completed';
    case 'cancelled':   return 'cancelled';
    default:            return 'upcoming';
  }
}

function buildGuestName(r) {
  const first = r.guest?.firstName || r.firstName || '';
  const last  = r.guest?.lastName  || r.lastName  || '';
  return `${first} ${last}`.trim() || 'Guesty Guest';
}

function parseMoney(r) {
  const raw = r.money?.totalPaid ?? r.money?.fareAccommodation ?? r.totalPrice ?? null;
  if (raw === null) return null;
  // Store in cents
  return Math.round(parseFloat(raw) * 100);
}
