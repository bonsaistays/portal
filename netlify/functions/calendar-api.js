/**
 * Bonsai Stays — Calendar API
 *
 * GET  ?action=get_month&property_id=X&year=Y&month=M  → overrides + base price
 * GET  ?action=get_fees&property_id=X                  → fee list
 * POST { action:'set_override',   property_id, date, is_blocked, custom_price, note }
 * POST { action:'delete_override', property_id, date }
 * POST { action:'save_fee',       property_id, id?, name, amount, fee_type, is_active }
 * POST { action:'delete_fee',     property_id, id }
 * POST { action:'save_markup',    property_id, markup_percent }  — admin only
 *
 * Auth: Authorization: Bearer <supabase_access_token>
 * Admin: user.app_metadata.role === 'admin'  (set via Supabase SQL — see setup notes)
 * Owner: user must exist in property_owners table for the given property_id
 */

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL || 'https://zmbhpebiiyqdfqznruwz.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  const h = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: h, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod))
    return { statusCode: 405, headers: h, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) return { statusCode: 401, headers: h, body: JSON.stringify({ error: 'Missing auth token' }) };
  if (!SB_KEY) return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'Server not configured' }) };

  const adminSb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
  const { data: { user }, error: authErr } = await adminSb.auth.getUser(jwt);
  if (authErr || !user) return { statusCode: 401, headers: h, body: JSON.stringify({ error: 'Invalid token' }) };

  // Admin check: app_metadata role OR ADMIN_EMAILS env var (comma-separated)
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const isAdmin = user.app_metadata?.role === 'admin' || adminEmails.includes(user.email?.toLowerCase());

  // ── Parse request ─────────────────────────────────────────────────────────
  let action, property_id, params;
  if (event.httpMethod === 'GET') {
    params = event.queryStringParameters || {};
    action = params.action;
    property_id = params.property_id;
  } else {
    try { params = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    action = params.action;
    property_id = params.property_id;
  }

  if (!property_id) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'property_id required' }) };

  // ── Ownership check ───────────────────────────────────────────────────────
  if (!isAdmin) {
    const { data: own } = await adminSb
      .from('property_owners')
      .select('id')
      .eq('user_id', user.id)
      .eq('property_id', property_id)
      .maybeSingle();
    if (!own) return { statusCode: 403, headers: h, body: JSON.stringify({
      error: 'Access denied',
      debug: {
        user_email: user.email,
        admin_emails_env: process.env.ADMIN_EMAILS || '(not set)',
        is_admin: isAdmin,
        app_meta_role: user.app_metadata?.role || '(none)',
      }
    }) };
  }

  try {
    // ── GET: month overrides ─────────────────────────────────────────────
    if (action === 'get_month') {
      const yr    = parseInt(params.year);
      const mo    = parseInt(params.month);
      const start = `${yr}-${String(mo).padStart(2, '0')}-01`;
      const end   = new Date(yr, mo, 0).toISOString().split('T')[0];

      const [{ data: overrides }, { data: prop }] = await Promise.all([
        adminSb.from('property_calendar_overrides').select('*').eq('property_id', property_id).gte('date', start).lte('date', end),
        adminSb.from('properties').select('price, markup_percent, name').eq('id', property_id).single(),
      ]);

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          overrides:      overrides || [],
          base_price:     prop?.price || 0,
          markup_percent: isAdmin ? (prop?.markup_percent || 0) : null,
          property_name:  prop?.name || '',
          is_admin:       isAdmin,
        }),
      };
    }

    // ── GET: fees ─────────────────────────────────────────────────────────
    if (action === 'get_fees') {
      const { data, error } = await adminSb
        .from('property_fees')
        .select('*')
        .eq('property_id', property_id)
        .order('fee_type').order('name');
      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ fees: data || [], is_admin: isAdmin }) };
    }

    // ── POST: set override ────────────────────────────────────────────────
    if (action === 'set_override') {
      const { date, is_blocked, custom_price, note } = params;
      if (!date) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'date required' }) };
      const { data, error } = await adminSb
        .from('property_calendar_overrides')
        .upsert({
          property_id,
          date,
          is_blocked:   !!is_blocked,
          custom_price: custom_price != null ? parseFloat(custom_price) : null,
          note:         note || null,
          updated_at:   new Date().toISOString(),
        }, { onConflict: 'property_id,date' })
        .select().single();
      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, override: data }) };
    }

    // ── POST: delete override ────────────────────────────────────────────
    if (action === 'delete_override') {
      const { date } = params;
      const { error } = await adminSb
        .from('property_calendar_overrides')
        .delete()
        .eq('property_id', property_id)
        .eq('date', date);
      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true }) };
    }

    // ── POST: save fee (admin only) ───────────────────────────────────────
    if (action === 'save_fee') {
      if (!isAdmin) return { statusCode: 403, headers: h, body: JSON.stringify({ error: 'Admin only' }) };
      const { id, name, amount, fee_type, is_active } = params;
      if (!name || amount == null) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'name and amount required' }) };
      let res;
      if (id) {
        res = await adminSb.from('property_fees')
          .update({ name, amount: parseFloat(amount), fee_type, is_active: is_active ?? true })
          .eq('id', id).eq('property_id', property_id).select().single();
      } else {
        res = await adminSb.from('property_fees')
          .insert({ property_id, name, amount: parseFloat(amount), fee_type, is_active: is_active ?? true })
          .select().single();
      }
      if (res.error) throw res.error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, fee: res.data }) };
    }

    // ── POST: delete fee (admin only) ────────────────────────────────────
    if (action === 'delete_fee') {
      if (!isAdmin) return { statusCode: 403, headers: h, body: JSON.stringify({ error: 'Admin only' }) };
      const { id } = params;
      const { error } = await adminSb.from('property_fees').delete().eq('id', id).eq('property_id', property_id);
      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true }) };
    }

    // ── POST: save markup (admin only) ───────────────────────────────────
    if (action === 'save_markup') {
      if (!isAdmin) return { statusCode: 403, headers: h, body: JSON.stringify({ error: 'Admin only' }) };
      const { markup_percent } = params;
      const { error } = await adminSb.from('properties')
        .update({ markup_percent: parseFloat(markup_percent) || 0 })
        .eq('id', property_id);
      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (e) {
    console.error('calendar-api error:', e.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
