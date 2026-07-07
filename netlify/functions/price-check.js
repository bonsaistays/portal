/**
 * Bonsai Stays — Public Price Check
 * GET  ?property_id=X&check_in=YYYY-MM-DD&check_out=YYYY-MM-DD
 *
 * Returns the full pricing breakdown for a stay:
 *   nights, nightly_total, fees_breakdown, grand_total
 *
 * Note: markup % and per-date base prices are NOT exposed — guests see only
 * the final guest-facing prices (base × markup applied transparently).
 *
 * No authentication required — public pricing endpoint.
 */

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  const h = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: h, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: h, body: JSON.stringify({ error: 'GET only' }) };

  const qs          = event.queryStringParameters || {};
  const property_id = qs.property_id;
  const check_in    = qs.check_in;
  const check_out   = qs.check_out;

  if (!property_id || !check_in || !check_out)
    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'property_id, check_in and check_out required' }) };

  if (!SB_KEY) return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'Server not configured' }) };

  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  try {
    const nights = Math.round((new Date(check_out) - new Date(check_in)) / 86400000);
    if (nights < 1) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Check-out must be after check-in' }) };

    const [{ data: prop }, { data: overrides }, { data: fees }] = await Promise.all([
      sb.from('properties').select('price, markup_percent, extra_fees, cleaning_fee').eq('id', property_id).single(),
      sb.from('property_calendar_overrides').select('date, is_blocked, custom_price')
        .eq('property_id', property_id).gte('date', check_in).lt('date', check_out),
      sb.from('property_fees').select('id, name, amount, fee_type')
        .eq('property_id', property_id).eq('is_active', true),
    ]);

    if (!prop) return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Property not found' }) };

    const basePrice  = prop.price || 0;
    const markupMult = 1 + ((prop.markup_percent || 0) / 100);
    const overrideMap = {};
    (overrides || []).forEach(o => { overrideMap[o.date] = o; });

    // Check for blocked dates
    const start = new Date(check_in + 'T12:00:00');
    let nightlyTotal = 0;
    const nightlyBreakdown = [];

    for (let i = 0; i < nights; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      const ov = overrideMap[dateStr];
      if (ov?.is_blocked) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ available: false, blocked_date: dateStr }) };
      }
      const rate  = (ov?.custom_price != null) ? ov.custom_price : basePrice;
      const final = Math.round(rate * markupMult * 100) / 100;
      nightlyTotal += final;
      nightlyBreakdown.push({ date: dateStr, price: final });
    }

    // Cleaning fee — blended silently into the displayed nightly rate
    const cleaningFee = prop.cleaning_fee || 0;
    const blendedNightlyTotal = nightlyTotal + cleaningFee;
    const blendedAvgNightly   = Math.round(blendedNightlyTotal / nights);

    // Merge property_fees table rows + extra_fees JSONB column (excludes cleaning fee)
    const allFees = [
      ...(fees || []).map(f => ({ name: f.name, amount: f.amount, fee_type: f.fee_type })),
      ...(prop.extra_fees || []).map(f => ({ name: f.name, amount: Number(f.amount), fee_type: f.type || 'flat' })),
    ];

    // Fees total (no markup on fees — fees are fixed)
    let feesTotal = 0;
    const feesBreakdown = [];
    allFees.forEach(f => {
      let total;
      if (f.fee_type === 'per_night') total = f.amount * nights;
      else if (f.fee_type === 'percent') total = blendedNightlyTotal * (f.amount / 100);
      else total = f.amount;
      feesTotal += total;
      feesBreakdown.push({ name: f.name, amount: f.amount, fee_type: f.fee_type, total });
    });

    const grandTotal = blendedNightlyTotal + feesTotal;

    return {
      statusCode: 200, headers: h,
      body: JSON.stringify({
        available:         true,
        nights,
        avg_nightly:       blendedAvgNightly,
        nightly_total:     Math.round(blendedNightlyTotal * 100) / 100,
        fees_total:        Math.round(feesTotal * 100) / 100,
        grand_total:       Math.round(grandTotal * 100) / 100,
        nightly_breakdown: nightlyBreakdown,
        fees_breakdown:    feesBreakdown,
      }),
    };

  } catch (e) {
    console.error('price-check error:', e.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
