import { Refusal } from './signals.js'

// Maintainer-only moderation, behind one secret (env.ADMIN_TOKEN, sent as the x-admin-token header; set with `wrangler secret put`).
// Hiding keeps the rows but drops them from every public count; it is reversible. No admin route exists without the secret set.
function same(a, b) { // constant-time string compare
  if (a.length !== b.length) return false
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export async function adminRoute(request, env, path) {
  const given = request.headers.get('x-admin-token') || ''
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24 || !same(given, env.ADMIN_TOKEN)) throw new Refusal(404, 'Not found.')
  const db = env.DB
  if (path === '/api/admin/reports' && request.method === 'GET') { // newest first, for spotting abuse
    const { results } = await db.prepare(`SELECT r.id, r.plugin_id, r.version, r.device, r.os, r.hidden, r.created_at, u.id AS user_id, u.name, u.email, u.hidden AS user_hidden
      FROM working_reports r JOIN "user" u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 100`).all()
    return { reports: results }
  }
  if (path === '/api/admin/hide' && request.method === 'POST') {
    const b = JSON.parse((await request.text()) || '{}'), hidden = b.hidden === false ? 0 : 1
    if (b.report) { const r = await db.prepare('UPDATE working_reports SET hidden = ? WHERE id = ?').bind(hidden, String(b.report)).run(); return { ok: true, changed: r.meta.changes } }
    if (b.user) { const r = await db.prepare('UPDATE "user" SET hidden = ? WHERE id = ? OR email = ?').bind(hidden, String(b.user), String(b.user)).run(); return { ok: true, changed: r.meta.changes } }
    throw new Refusal(400, 'Send {"report": id} or {"user": id or email}, and "hidden": false to restore.')
  }
  throw new Refusal(404, 'Not found.')
}
