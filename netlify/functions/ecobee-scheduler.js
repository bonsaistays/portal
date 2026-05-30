// ecobee-scheduler.js
// Runs every 30 minutes via Netlify scheduled function.
// - 2 hours before check-in  → sets thermostat to property's guest temp
// - After check-out time     → reverts to property's owner temp
//
// Schedule is set in netlify.toml:
//   [functions."ecobee-scheduler"]
//     schedule = "*/30 * * * *"

const SUPABASE_URL = process.env.SUPABASE_URL;
const SB_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL     = process.env.URL || 'https://bonsaistays.netlify.app'; // your Netlify site URL

async function sb(path, method = 'GET', body = null) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json();
}

async function ecobee(action, params) {
  const r = await fetch(`${BASE_URL}/.netlify/functions/ecobee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  return r.json();
}

exports.handler = async () => {
  const now       = new Date();
  const twoHrsMs  = 2 * 60 * 60 * 1000;

  console.log('ecobee-scheduler running at', now.toISOString());

  // Fetch bookings that are upcoming or active, with property ecobee info
  // Window: check-in within the next 2h15m, OR checked out within the last 30m
  const windowStart = new Date(now.getTime() - 30 * 60 * 1000).toISOString();  // 30 min ago
  const windowEnd   = new Date(now.getTime() + twoHrsMs + 15 * 60 * 1000).toISOString(); // 2h15m from now

  const bookings = await sb(
    `bookings?select=id,check_in,check_out,status,guest_heat_temp_f,guest_cool_temp_f,ecobee_preheat_done,ecobee_revert_done,properties(ecobee_thermostat_id,ecobee_owner_heat_f,ecobee_owner_cool_f,ecobee_guest_heat_f,ecobee_guest_cool_f)&status=in.(upcoming,active)&check_in=lte.${windowEnd}&check_out=gte.${windowStart}`
  );

  if (!Array.isArray(bookings)) {
    console.log('No bookings found or error:', bookings);
    return { statusCode: 200, body: 'done' };
  }

  for (const b of bookings) {
    const p = b.properties;
    if (!p?.ecobee_thermostat_id) continue;

    const checkIn  = new Date(b.check_in);
    const checkOut = new Date(b.check_out);
    const msToCheckIn  = checkIn  - now;
    const msAfterCheckOut = now - checkOut;

    // ── Preheat: 2h before check-in ──────────────────────────────────────
    if (!b.ecobee_preheat_done && msToCheckIn <= twoHrsMs && msToCheckIn > 0) {
      const heatF = b.guest_heat_temp_f || p.ecobee_guest_heat_f || 70;
      const coolF = b.guest_cool_temp_f || p.ecobee_guest_cool_f || 74;

      console.log(`Preheating for booking ${b.id}: heat=${heatF}F cool=${coolF}F`);
      const result = await ecobee('set', {
        thermostat_id: p.ecobee_thermostat_id,
        heat_temp_f: heatF,
        cool_temp_f: coolF,
      });
      console.log('Preheat result:', result);

      await sb(`bookings?id=eq.${b.id}`, 'PATCH', { ecobee_preheat_done: true });
    }

    // ── Revert: after check-out ───────────────────────────────────────────
    if (!b.ecobee_revert_done && msAfterCheckOut >= 0 && msAfterCheckOut <= 35 * 60 * 1000) {
      const ownerHeatF = p.ecobee_owner_heat_f || 65;
      const ownerCoolF = p.ecobee_owner_cool_f || 78;

      console.log(`Reverting thermostat for booking ${b.id}: heat=${ownerHeatF}F cool=${ownerCoolF}F`);
      // Resume the normal schedule first, then set owner temps as fallback
      await ecobee('resume', { thermostat_id: p.ecobee_thermostat_id });

      // Also set a hold at owner temps just to be safe
      await ecobee('set', {
        thermostat_id: p.ecobee_thermostat_id,
        heat_temp_f: ownerHeatF,
        cool_temp_f: ownerCoolF,
      });

      await sb(`bookings?id=eq.${b.id}`, 'PATCH', { ecobee_revert_done: true });
    }
  }

  return { statusCode: 200, body: 'done' };
};
