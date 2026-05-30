// seam-devices.js
// Lists all devices connected to your Seam account.
// GET  /.netlify/functions/seam-devices          → all devices
// GET  /.netlify/functions/seam-devices?type=lock → filter by device_type (lock | thermostat | sensor …)

exports.handler = async (event) => {
  const SEAM_API_KEY = process.env.SEAM_API_KEY;

  if (!SEAM_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SEAM_API_KEY not configured in Netlify env vars' }) };
  }

  const deviceType = event.queryStringParameters?.type || null;

  let url = 'https://connect.getseam.com/devices/list';
  if (deviceType) url += '?device_type=' + encodeURIComponent(deviceType);

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

  // Return a slimmed-down list with only what the UI needs
  const devices = (data.devices || []).map(d => ({
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
