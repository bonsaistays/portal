/**
 * Smart Lock Control — Bonsai Stays
 * Supports: Seam (unified — August, Yale, Schlage, etc.), TTLock, RemoteLock, igloohome
 *
 * Required environment variables (set in Netlify UI → Site Settings → Environment):
 *   SEAM_API_KEY          — Seam API key (from console.seam.co) ← primary integration
 *   TTLOCK_CLIENT_ID      — TTLock OAuth client ID
 *   TTLOCK_CLIENT_SECRET  — TTLock OAuth client secret
 *   TTLOCK_ACCESS_TOKEN   — TTLock access token (from your TTLock account)
 *   REMOTELOCK_TOKEN      — RemoteLock API token
 *   IGLOOHOME_CLIENT_ID   — igloohome client ID
 *   IGLOOHOME_CLIENT_SECRET — igloohome client secret
 *   SUPABASE_URL          — same as your public Supabase URL
 *   SUPABASE_SERVICE_KEY  — Supabase service role key (NOT anon key)
 */

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, deviceId, provider, propertyId } = body;
  if (!action || !deviceId || !provider) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  // Verify booking is active for this property (security check)
  if (SB_KEY && propertyId) {
    const sb = createClient(SB_URL, SB_KEY);
    const now = new Date().toISOString();
    const { data: booking } = await sb
      .from('bookings')
      .select('id, status')
      .eq('property_id', propertyId)
      .in('status', ['active', 'confirmed'])
      .lte('check_in', now)
      .gte('check_out', now)
      .single();
    if (!booking) {
      return { statusCode: 403, body: JSON.stringify({ error: 'No active booking for this property' }) };
    }
  }

  try {
    let result;
    switch ((provider || '').toLowerCase()) {
      case 'ttlock':
        result = await controlTTLock(action, deviceId);
        break;
      case 'seam':
      case 'august':
      case 'yale':
      case 'schlage':
        result = await controlSeam(action, deviceId);
        break;
      case 'remotelock':
        result = await controlRemoteLock(action, deviceId);
        break;
      case 'igloohome':
        result = await controlIgloohome(action, deviceId);
        break;
      default:
        return { statusCode: 400, body: JSON.stringify({ error: `Unsupported provider: ${provider}` }) };
    }
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch(e) {
    console.error('Lock control error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

/* ── TTLock ── */
async function controlTTLock(action, lockId) {
  const clientId    = process.env.TTLOCK_CLIENT_ID;
  const accessToken = process.env.TTLOCK_ACCESS_TOKEN;
  if (!clientId || !accessToken) throw new Error('TTLock credentials not configured');

  const date = Date.now();
  const baseUrl = 'https://euapi.ttlock.com'; // Use euapi for Canada

  if (action === 'status') {
    const params = new URLSearchParams({ clientId, accessToken, lockId, date });
    const res = await fetch(`${baseUrl}/v3/lock/queryOpenState?${params}`);
    const data = await res.json();
    // state: 0=locked, 1=unlocked
    return { locked: data.state === 0, raw: data };
  }

  if (action === 'unlock') {
    const params = new URLSearchParams({ clientId, accessToken, lockId, date });
    const res = await fetch(`${baseUrl}/v3/lock/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) throw new Error(data.errmsg || 'TTLock unlock failed');
    return { locked: false };
  }

  if (action === 'lock') {
    const params = new URLSearchParams({ clientId, accessToken, lockId, date });
    const res = await fetch(`${baseUrl}/v3/lock/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) throw new Error(data.errmsg || 'TTLock lock failed');
    return { locked: true };
  }

  throw new Error('Unknown action: ' + action);
}

/* ── Seam (unified API — August, Yale, Schlage, and 50+ brands) ── */
async function controlSeam(action, deviceId) {
  const apiKey = process.env.SEAM_API_KEY;
  if (!apiKey) throw new Error('Seam API key not configured. Add SEAM_API_KEY in Netlify environment variables.');

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const base = 'https://connect.getseam.com';

  if (action === 'status') {
    const res  = await fetch(`${base}/locks/get`, {
      method: 'POST', headers,
      body: JSON.stringify({ device_id: deviceId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Seam status error ${res.status}`);
    const locked = data.lock?.locked_status === 'locked';
    return { locked };
  }

  if (action === 'unlock') {
    const res  = await fetch(`${base}/locks/unlock_door`, {
      method: 'POST', headers,
      body: JSON.stringify({ device_id: deviceId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Seam unlock error ${res.status}`);
    return { locked: false };
  }

  if (action === 'lock') {
    const res  = await fetch(`${base}/locks/lock_door`, {
      method: 'POST', headers,
      body: JSON.stringify({ device_id: deviceId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Seam lock error ${res.status}`);
    return { locked: true };
  }

  throw new Error('Unknown action: ' + action);
}

/* ── RemoteLock ── */
async function controlRemoteLock(action, deviceId) {
  const token = process.env.REMOTELOCK_TOKEN;
  if (!token) throw new Error('RemoteLock token not configured');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = 'https://connect.remotelock.com/api';

  if (action === 'status') {
    const res = await fetch(`${base}/access_persons?device_id=${deviceId}`, { headers });
    const data = await res.json();
    return { locked: true, raw: data }; // RemoteLock is PIN-based; return locked as default
  }

  if (action === 'unlock') {
    const res = await fetch(`${base}/devices/${deviceId}/unlock`, { method: 'POST', headers, body: '{}' });
    const data = await res.json();
    return { locked: false, raw: data };
  }

  return { locked: true };
}

/* ── igloohome ── */
async function controlIgloohome(action, deviceId) {
  // igloohome uses PIN-based access — remote unlock not available on all models
  // This generates a time-based OTP PIN instead
  const clientId     = process.env.IGLOOHOME_CLIENT_ID;
  const clientSecret = process.env.IGLOOHOME_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('igloohome credentials not configured');

  // Get access token
  const tokenRes = await fetch('https://api.igloohome.co/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, grantType: 'client_credentials' })
  });
  const { accessToken } = await tokenRes.json();

  if (action === 'status') {
    return { locked: true, note: 'igloohome uses PIN codes — see door code above' };
  }

  if (action === 'unlock') {
    // igloohome Pro models support remote unlock
    const res = await fetch(`https://api.igloohome.co/v1/devices/${deviceId}/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    return { locked: false, raw: data };
  }

  return { locked: true };
}
