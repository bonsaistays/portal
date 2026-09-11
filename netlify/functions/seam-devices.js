// seam-devices.js
// Lists all devices connected to your Seam account.
// GET  /.netlify/functions/seam-devices          → all devices
// GET  /.netlify/functions/seam-devices?type=lock → filter by device_type (lock | thermostat | sensor …)

exports.handler = async (event) => {
  const SEAM_API_KEY = process.env.SEAM_API_KEY;

  if (!SEAM_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SEAM_API_KEY not configured in Netlify env vars' }) };
  }

  const filterType = event.queryStringParameters?.type || null; // 'lock' | 'thermostat' | 'any'

  // Seam doesn't accept generic 'lock' — fetch all and filter client-side
  const url = 'https://connect.getseam.com/devices/list';

  let res, data;
  try {
    res  = await fetch(url, { headers: { Authorization: `Bearer ${SEAM_API_KEY}` } });
    data = await res.json();
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Cannot reach Seam: ' + err.message }) };
  }

  if (!res.ok) {
    return { statusCode: res.status, body: JSON.stringify({ error: data?.error?.message || JSON.stringify(data) }) };
  }

  // Filter by category if requested ('lock' or 'thermostat')
  const rawDevices = (data.devices || []).filter(d => {
    if (!filterType || filterType === 'any') return true;
    if (filterType === 'lock') return d.device_type?.includes('lock');
    if (filterType === 'thermostat') return d.device_type?.includes('thermostat') || d.device_type?.includes('ecobee');
    return true;
  });

  // Return a slimmed-down list with only what the UI needs
  const devices = rawDevices.map(d => ({
    device_id:    d.device_id,
    display_name: d.display_name || d.properties?.name || d.device_id,
    device_type:  d.device_type,
    manufacturer: d.properties?.manufacturer || '',
    model:        d.properties?.model || '',
    online:       d.properties?.online ?? null,
    // lock-specific
    locked:       d.properties?.locked ?? null,
    // thermostat-specific
    current_temp_f:    d.properties?.current_climate_setting?.temperature_fahrenheit ?? null,
    current_temp_c:    d.properties?.current_climate_setting?.temperature_celsius ?? null,
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, devices }),
  };
};
