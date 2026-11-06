import { allowedOrigins } from './auth.js'
import { knownPlugins } from './catalog.js'
import { newToken } from './feed.js'

export class Refusal extends Error { constructor(status, message) { super(message); this.status = status } }

// Per person, per day. A page that is not a script needs far less; this only blunts a script.
export const LIMITS = { reportsPerDay: 30, likesPerDay: 200, follows: 300 }

const DEVICE = /^[\p{L}\p{N} ()+.,'/-]{2,60}$/u
const OS = /^[\p{L}\p{N} ._+()-]{1,32}$/u

async function body(request) {
  const text = await request.text()
  if (text.length > 2048) throw new Refusal(413, 'That request is too large.')
  try { const v = JSON.parse(text || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v } catch {}
  throw new Refusal(400, 'Send a JSON object.')
}
const str = (v, what, re) => { if (typeof v !== 'string' || !re.test(v.trim())) throw new Refusal(400, 'Check ' + what + '.'); return v.trim() }

async function plugin(env, id, version) {
  const known = await knownPlugins(env)
  if (!known) throw new Refusal(503, 'The catalog could not be read; try again later.')
  const versions = known.get(id)
  if (!versions) throw new Refusal(400, 'Unknown plugin.')
  if (version !== undefined && !versions.has(version)) throw new Refusal(400, 'Unknown version of that plugin.')
}

async function overLimit(db, table, userId, max) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND created_at > datetime('now', '-1 day')`).bind(userId).first()
  return row.n >= max
}

// Every route here needs a signed-in person (bearer session) and a request from an allowed page.
export async function signalRoute(request, env, auth, path) {
  const origin = request.headers.get('origin')
  if (!origin || !allowedOrigins(env).includes(origin)) throw new Refusal(403, 'This request must come from the catalog page.')
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) throw new Refusal(401, 'Sign in first.')
  const me = session.user.id, db = env.DB, m = request.method

  if (path === '/api/me' && m === 'GET') {
    const [likes, reports, follows, token] = await db.batch([
      db.prepare('SELECT plugin_id FROM likes WHERE user_id = ? ORDER BY plugin_id').bind(me),
      db.prepare('SELECT plugin_id, version, device, os FROM working_reports WHERE user_id = ? ORDER BY created_at DESC').bind(me),
      db.prepare('SELECT plugin_id FROM follows WHERE user_id = ? ORDER BY plugin_id').bind(me),
      db.prepare('SELECT token FROM feed_tokens WHERE user_id = ?').bind(me)])
    const t = token.results[0]?.token
    return { user: { id: me, name: session.user.name }, likes: likes.results.map(r => r.plugin_id), reports: reports.results,
      follows: follows.results.map(r => r.plugin_id), feedUrl: t ? `${env.BASE_URL}/feed/${t}.xml` : null }
  }
  if (path === '/api/follow' && (m === 'POST' || m === 'DELETE')) {
    const id = str((await body(request)).plugin, 'the plugin', /^[a-z0-9][a-z0-9-]{0,63}$/)
    if (m === 'DELETE') { await db.prepare('DELETE FROM follows WHERE plugin_id = ? AND user_id = ?').bind(id, me).run(); return { ok: true } }
    await plugin(env, id)
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?').bind(me).first()).n
    if (n >= LIMITS.follows) throw new Refusal(429, 'You follow as many plugins as allowed.')
    // the first follow also creates the person's feed address
    await db.batch([
      db.prepare('INSERT INTO follows (plugin_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(id, me),
      db.prepare('INSERT INTO feed_tokens (user_id, token) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(me, newToken())])
    const t = (await db.prepare('SELECT token FROM feed_tokens WHERE user_id = ?').bind(me).first()).token
    return { ok: true, feedUrl: `${env.BASE_URL}/feed/${t}.xml` }
  }
  if (path === '/api/feed/rotate' && m === 'POST') {   // a new secret address; the old one stops working at once
    const t = newToken()
    await db.prepare('INSERT INTO feed_tokens (user_id, token) VALUES (?1, ?2) ON CONFLICT (user_id) DO UPDATE SET token = ?2, created_at = CURRENT_TIMESTAMP').bind(me, t).run()
    return { ok: true, feedUrl: `${env.BASE_URL}/feed/${t}.xml` }
  }
  if (path === '/api/me' && m === 'DELETE') {
    if ((await body(request)).confirm !== 'delete my account') throw new Refusal(400, 'Confirm with {"confirm":"delete my account"}.')
    await db.prepare('DELETE FROM "user" WHERE id = ?').bind(me).run() // sessions, accounts, likes and reports cascade
    return { ok: true }
  }
  if (path === '/api/like' && (m === 'POST' || m === 'DELETE')) {
    const id = str((await body(request)).plugin, 'the plugin', /^[a-z0-9][a-z0-9-]{0,63}$/)
    if (m === 'DELETE') { await db.prepare('DELETE FROM likes WHERE plugin_id = ? AND user_id = ?').bind(id, me).run(); return { ok: true } }
    await plugin(env, id)
    if (await overLimit(db, 'likes', me, LIMITS.likesPerDay)) throw new Refusal(429, 'Too many likes today; try again tomorrow.')
    await db.prepare('INSERT INTO likes (plugin_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(id, me).run()
    return { ok: true }
  }
  if (path === '/api/working' && (m === 'POST' || m === 'DELETE')) {
    const b = await body(request)
    const id = str(b.plugin, 'the plugin', /^[a-z0-9][a-z0-9-]{0,63}$/), version = str(b.version, 'the version', /^[\w.+-]{1,64}$/)
    const device = str(b.device, 'the device', DEVICE), os = str(b.os, 'the OS version', OS)
    if (m === 'DELETE') { await db.prepare('DELETE FROM working_reports WHERE user_id = ? AND plugin_id = ? AND version = ? AND device = ? AND os = ?').bind(me, id, version, device, os).run(); return { ok: true } }
    await plugin(env, id, version)
    if (await overLimit(db, 'working_reports', me, LIMITS.reportsPerDay)) throw new Refusal(429, 'Too many reports today; try again tomorrow.')
    const r = await db.prepare('INSERT INTO working_reports (id, user_id, plugin_id, version, device, os) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(crypto.randomUUID(), me, id, version, device, os).run()
    return { ok: true, created: r.meta.changes > 0 }
  }
  throw new Refusal(405, 'Use a supported method.')
}
