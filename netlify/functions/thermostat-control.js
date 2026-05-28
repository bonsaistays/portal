/**
 * Smart Thermostat Control — Bonsai Stays
 * Supports: ecobee, Nest (Google SDM), Honeywell/Resideo, Sensibo
 *
 * Required environment variables (set in Netlify UI → Site Settings → Environment):
 *   ECOBEE_API_KEY         — ecobee API key (from developer.ecobee.com)
 *   ECOBEE_ACCESS_TOKEN    — ecobee OAuth access token
 *   ECOBEE_REFRESH_TOKEN   — ecobee OAuth refresh token
 *   NEST_PROJECT_ID        — Google SDM project ID
 *   NEST_ACCESS_TOKEN      — Google SDM OAuth access token
 *   HONEYWELL_CONSUMER_KEY — Honeywell/Resideo consumer key
 *   HONEYWELL_ACCESS_TOKEN — Honeywell OAuth access token
 *   SENSIBO_API_KEY        — Sensibo API key (from home.sensibo.com)
 *   SUPABASE_URL           — Supabase URL
 *   SUPABASE_SERVICE_KEY   — Supabase service role key
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, deviceId, provider, setpoint, mode } = body;
  if (!action || !deviceId || !provider) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  try {
    let result;
    switch ((provider || '').toLowerCase()) {
      case 'ecobee':
        result = await controlEcobee(action, deviceId, setpoint, mode);
        break;
      case 'nest':
      case 'google':
        result = await controlNest(action, deviceId, setpoint, mode);
        break;
      case 'honeywell':
      case 'resideo':
        result = await controlHoneywell(action, deviceId, setpoint, mode);
        break;
      case 'sensibo':
        result = await controlSensibo(action, deviceId, setpoint, mode);
        break;
      default:
        return { statusCode: 400, body: JSON.stringify({ error: `Unsupported provider: ${provider}` }) };
    }
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch(e) {
    console.error('Thermostat control error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

/* ── ecobee ── */
async function controlEcobee(action, thermostatId, setpoint, mode) {
  const token = process.env.ECOBEE_ACCESS_TOKEN;
  if (!token) throw new Error('ecobee access token not configured');

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  if (action === 'get') {
    const selection = JSON.stringify({
      selection: {
        selectionType: 'thermostats',
        selectionMatch: thermostatId,
        includeRuntime: true,
        includeSensors: true,
        includeSettings: true,
      }
    });
    const res = await fetch(
      `https://api.ecobee.com/1/thermostat?json=${encodeURIComponent(selection)}`,
      { headers }
    );
    const data = await res.json();
    if (!data.thermostatList?.length) throw new Error('Thermostat not found');
    const t = data.thermostatList[0];
    const rt = t.runtime;
    const settings = t.settings;

    // ecobee uses Fahrenheit internally — convert to Celsius (÷10 for tenths, then convert)
    const currentF  = rt.actualTemperature / 10;
    const setpointF = settings.hvacMode === 'heat'
      ? rt.desiredHeat / 10
      : rt.desiredCool / 10;

    return {
      currentTemp: fToC(currentF),
      setpoint:    fToC(setpointF),
      mode:        settings.hvacMode,   // 'heat'|'cool'|'auto'|'off'
      humidity:    rt.actualHumidity,
      running:     rt.hvacMode === 'heatStage1' || rt.hvacMode === 'heatStage2' ? 'heating'
                 : rt.hvacMode === 'coolStage1' || rt.hvacMode === 'coolStage2' ? 'cooling'
                 : 'idle',
    };
  }

  if (action === 'set') {
    const setpointF = setpoint != null ? Math.round(cToF(setpoint) * 10) : null;
    const body = {
      selection: { selectionType: 'thermostats', selectionMatch: thermostatId },
      thermostat: {
        settings: { hvacMode: mode || 'auto' },
        ...(setpointF ? {
          runtime: {
            desiredHeat: mode === 'cool' ? undefined : setpointF,
            desiredCool: mode === 'heat' ? undefined : setpointF,
          }
        } : {})
      }
    };
    const res = await fetch('https://api.ecobee.com/1/thermostat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.status?.code !== 0) throw new Error(data.status?.message || 'ecobee update failed');
    // Re-fetch to return fresh state
    return await controlEcobee('get', thermostatId);
  }

  throw new Error('Unknown action: ' + action);
}

/* ── Google Nest (SDM API) ── */
async function controlNest(action, deviceId, setpoint, mode) {
  const projectId = process.env.NEST_PROJECT_ID;
  const token     = process.env.NEST_ACCESS_TOKEN;
  if (!projectId || !token) throw new Error('Nest credentials not configured');

  const base = `https://smartdevicemanagement.googleapis.com/v1/enterprises/${projectId}/devices/${deviceId}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  if (action === 'get') {
    const res  = await fetch(base, { headers });
    const data = await res.json();
    const traits = data.traits || {};
    const tempTrait = traits['sdm.devices.traits.Temperature'] || {};
    const hvacTrait = traits['sdm.devices.traits.ThermostatHvac'] || {};
    const setpointTrait = traits['sdm.devices.traits.ThermostatTemperatureSetpoint'] || {};
    const modeTrait = traits['sdm.devices.traits.ThermostatMode'] || {};
    const humTrait  = traits['sdm.devices.traits.Humidity'] || {};

    return {
      currentTemp: tempTrait.ambientTemperatureCelsius,
      setpoint: setpointTrait.heatCelsius || setpointTrait.coolCelsius,
      mode: (modeTrait.mode || 'HEAT').toLowerCase(),
      humidity: humTrait.ambientHumidityPercent,
      running: (hvacTrait.status || 'OFF') === 'HEATING' ? 'heating'
             : (hvacTrait.status || 'OFF') === 'COOLING' ? 'cooling'
             : 'idle',
    };
  }

  if (action === 'set') {
    // Set mode
    if (mode) {
      await fetch(`${base}:executeCommand`, {
        method: 'POST', headers,
        body: JSON.stringify({ command: 'sdm.devices.commands.ThermostatMode.SetMode', params: { mode: mode.toUpperCase() } })
      });
    }
    // Set temperature
    if (setpoint != null) {
      const cmd = mode === 'cool' ? 'SetCool' : 'SetHeat';
      const param = mode === 'cool' ? 'coolCelsius' : 'heatCelsius';
      await fetch(`${base}:executeCommand`, {
        method: 'POST', headers,
        body: JSON.stringify({ command: `sdm.devices.commands.ThermostatTemperatureSetpoint.${cmd}`, params: { [param]: setpoint } })
      });
    }
    return await controlNest('get', deviceId);
  }

  throw new Error('Unknown action: ' + action);
}

/* ── Honeywell / Resideo ── */
async function controlHoneywell(action, deviceId, setpoint, mode) {
  const token = process.env.HONEYWELL_ACCESS_TOKEN;
  const apiKey = process.env.HONEYWELL_CONSUMER_KEY;
  if (!token) throw new Error('Honeywell access token not configured');

  // deviceId format: "locationId:deviceId"
  const [locationId, devId] = (deviceId || '').split(':');
  const headers = {
    Authorization: `Bearer ${token}`,
    'apikey': apiKey,
    'Content-Type': 'application/json',
  };
  const base = 'https://api.resideo.com';

  if (action === 'get') {
    const res  = await fetch(`${base}/v2/devices/thermostats/${devId}?locationId=${locationId}`, { headers });
    const data = await res.json();
    return {
      currentTemp: data.indoorTemperature != null ? fToC(data.indoorTemperature) : null,
      setpoint:    data.changeableValues?.heatSetpoint != null ? fToC(data.changeableValues.heatSetpoint) : null,
      mode:        (data.changeableValues?.mode || 'Heat').toLowerCase(),
      humidity:    data.indoorHumidity,
      running:     data.operationStatus?.mode === 'Heat' ? 'heating'
                 : data.operationStatus?.mode === 'Cool' ? 'cooling'
                 : 'idle',
    };
  }

  if (action === 'set') {
    const payload = {
      mode: mode ? capitalise(mode) : undefined,
      heatSetpoint: setpoint && mode !== 'cool' ? Math.round(cToF(setpoint)) : undefined,
      coolSetpoint: setpoint && mode !== 'heat' ? Math.round(cToF(setpoint)) : undefined,
    };
    await fetch(`${base}/v2/devices/thermostats/${devId}?locationId=${locationId}`, {
      method: 'POST', headers, body: JSON.stringify(payload)
    });
    return await controlHoneywell('get', deviceId);
  }

  throw new Error('Unknown action: ' + action);
}

/* ── Sensibo (mini-split / portable AC) ── */
async function controlSensibo(action, podUid, setpoint, mode) {
  const apiKey = process.env.SENSIBO_API_KEY;
  if (!apiKey) throw new Error('Sensibo API key not configured');

  const base = 'https://home.sensibo.com/api/v2';
  const qs = `?apiKey=${apiKey}`;

  if (action === 'get') {
    const res  = await fetch(`${base}/pods/${podUid}?fields=measurements,acState${qs}`);
    const data = await res.json();
    const result = data.result || {};
    return {
      currentTemp: result.measurements?.temperature,
      setpoint:    result.acState?.targetTemperature,
      mode:        result.acState?.mode,
      humidity:    result.measurements?.humidity,
      running:     result.acState?.on && result.acState?.mode !== 'fan' ? result.acState.mode === 'heat' ? 'heating' : 'cooling' : 'idle',
    };
  }

  if (action === 'set') {
    const payload = {
      acState: {
        on: mode !== 'off',
        mode: mode === 'off' ? 'cool' : mode,
        targetTemperature: setpoint != null ? Math.round(setpoint) : undefined,
      }
    };
    const res = await fetch(`${base}/pods/${podUid}/acStates${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.status !== 'success') throw new Error('Sensibo update failed');
    return await controlSensibo('get', podUid);
  }

  throw new Error('Unknown action: ' + action);
}

/* ── Helpers ── */
const fToC = f => parseFloat(((f - 32) * 5 / 9).toFixed(1));
const cToF = c => parseFloat((c * 9 / 5 + 32).toFixed(1));
const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
