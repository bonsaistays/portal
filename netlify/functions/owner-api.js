/**
 * Bonsai Stays — Owner Management API
 * Admin-only. Creates and manages property owner accounts.
 *
 * POST { action: 'create_owner', email, password, name?, property_id? }
 * POST { action: 'list_owners' }
 * POST { action: 'link_property',  owner_id (property_owners row), user_id, property_id }
 * POST { action: 'unlink_property', owner_id (property_owners row id) }
 * POST { action: 'get_properties' }  — returns all properties for selector
 *
 * Auth: Authorization: Bearer <admin_access_token>
 * Requires: user.app_metadata.role === 'admin'
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
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: h, body: JSON.stringify({ error: 'POST only' }) };

  // ── Auth (admin only) ─────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) return { statusCode: 401, headers: h, body: JSON.stringify({ error: 'Unauthorized' }) };
  if (!SB_KEY) return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'Server not configured' }) };

  const adminSb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
  const { data: { user }, error: authErr } = await adminSb.auth.getUser(jwt);
  if (authErr || !user) return { statusCode: 401, headers: h, body: JSON.stringify({ error: 'Invalid token' }) };
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const isAdmin = user.app_metadata?.role === 'admin' || adminEmails.includes(user.email?.toLowerCase());
  if (!isAdmin)
    return { statusCode: 403, headers: h, body: JSON.stringify({ error: 'Admin access required' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action } = body;

  try {
    // ── Create owner account ────────────────────────────────────────────
    if (action === 'create_owner') {
      const { email, password, name, property_id } = body;
      if (!email || !password) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'email and password required' }) };

      const { data: newUser, error: createErr } = await adminSb.auth.admin.createUser({
        email:         email.toLowerCase().trim(),
        password,
        email_confirm: true,
        app_metadata:  { role: 'owner' },
        user_metadata: { full_name: name || '' },
      });
      if (createErr) throw createErr;

      const userId = newUser.user.id;

      if (property_id) {
        const { error: linkErr } = await adminSb
          .from('property_owners')
          .insert({ user_id: userId, property_id });
        if (linkErr) throw linkErr;
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, user_id: userId }) };
    }

    // ── List all owners ─────────────────────────────────────────────────
    if (action === 'list_owners') {
      const { data: rows, error } = await adminSb
        .from('property_owners')
        .select('id, user_id, property_id, created_at, properties(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Batch-fetch emails for unique user IDs
      const userIds = [...new Set((rows || []).map(r => r.user_id))];
      const emailMap = {};
      const nameMap  = {};
      await Promise.all(userIds.map(async uid => {
        const { data: u } = await adminSb.auth.admin.getUserById(uid);
        if (u?.user) {
          emailMap[uid] = u.user.email;
          nameMap[uid]  = u.user.user_metadata?.full_name || '';
        }
      }));

      const owners = (rows || []).map(r => ({
        id:            r.id,
        user_id:       r.user_id,
        property_id:   r.property_id,
        property_name: r.properties?.name || '—',
        email:         emailMap[r.user_id] || '(unknown)',
        name:          nameMap[r.user_id]  || '',
        created_at:    r.created_at,
      }));

      return { statusCode: 200, headers: h, body: JSON.stringify({ owners }) };
    }

    // ── Link owner to additional property ─────────────────────────────
    if (action === 'link_property') {
      const { user_id, property_id } = body;
      if (!user_id || !property_id) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'user_id and property_id required' }) };
      const { error } = await adminSb.from('property_owners').insert({ user_id, property_id });
      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true }) };
    }

    // ── Unlink owner from property ─────────────────────────────────────
    if (action === 'unlink_property') {
      const { owner_id } = body; // property_owners row id
      if (!owner_id) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'owner_id required' }) };
      const { error } = await adminSb.from('property_owners').delete().eq('id', owner_id);
      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true }) };
    }

    // ── Get properties list (for the link dropdown) ────────────────────
    if (action === 'get_properties') {
      const { data, error } = await adminSb.from('properties').select('id, name').order('name');
      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ properties: data || [] }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (e) {
    console.error('owner-api error:', e.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
