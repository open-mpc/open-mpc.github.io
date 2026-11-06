import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

// Bundle the Worker for Miniflare (it does not bundle node_modules; a real `wrangler deploy` does this itself). Better Auth's
// Kysely adapter has an optional `import(nodeSqlite)` that Miniflare's static loader rejects; this build, for tests only,
// turns it into the "no such module" rejection that the library already handles.
export async function buildWorker(outfile = '.build/worker.js') {
  await build({ entryPoints: ['src/index.js'], bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser', 'import'], external: ['node:*', 'cloudflare:*'], outfile, logLevel: 'silent' })
  const src = readFileSync(outfile, 'utf8')
  const patched = src.replace(/await import\(\s*(?:\/\*[^*]*\*\/\s*)*nodeSqlite\s*\)/g, "await Promise.reject(Object.assign(new Error('no node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' }))")
  if (patched === src) throw new Error('the node:sqlite import was not found: update test/helpers.js')
  writeFileSync(outfile, patched)
  return outfile
}

// Apply every migrations/*.sql file, in order, to a D1 database (the same files `wrangler d1 migrations apply` would run).
import { readdirSync } from 'node:fs'
export async function applyMigrations(db) {
  for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort())
    for (const stmt of readFileSync('migrations/' + file, 'utf8').replace(/^--.*$/gm, '').split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean))
      await db.exec(stmt.replace(/\s+/g, ' ') + ';')
}

// A fake OAuth provider and a fake catalog.json on one local server; change `server.profile` between sign-ins to be someone else.
import http from 'node:http'
export const CATALOG = { plugins: [
  { id: 'acid-303', name: 'Acid <303>', author: 'Z', summary: 'A bassline', versions: [
    { version: '1.1.0', date: '2026-10-20', url: 'https://x/a-1.1.0.zip?a=1&b=2', channel: 'stable', yanked: false, notes: 'Fixes  the\nclick <b>noise</b>' },
    { version: '1.0.5', date: '2026-10-10', url: 'https://x/a-1.0.5.zip', channel: 'stable', yanked: true },
    { version: '1.0.0', date: '2026-10-01', url: 'https://x/a-1.0.0.zip', channel: 'stable', yanked: false }] },
  { id: 'other', name: 'Other', author: 'Y', summary: 'Another', versions: [{ version: '2.0.0', date: '2026-10-25', url: 'https://x/o-2.0.0.zip', channel: 'beta', yanked: false }] },
  { id: 'third', name: 'Third', author: 'X', summary: 'Never followed', versions: [{ version: '1.0.0', date: '2026-10-30', url: 'https://x/t.zip', channel: 'stable', yanked: false }] }] }
export async function startFake() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (u.pathname === '/authorize') { res.writeHead(302, { location: u.searchParams.get('redirect_uri') + '?code=abc&state=' + u.searchParams.get('state') }); return res.end() }
    if (u.pathname === '/token') return send(200, { access_token: 'at', token_type: 'Bearer', expires_in: 3600 })
    if (u.pathname === '/userinfo') return send(200, server.profile)
    if (u.pathname === '/catalog.json') return send(200, CATALOG)
    res.writeHead(404); res.end()
  })
  server.profile = { id: 'p1', sub: 'p1', email: 'fan@example.test', email_verified: true, name: 'Fan' }
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  server.url = 'http://127.0.0.1:' + server.address().port
  return server
}

// Full sign-in with the fake provider; resolves to a bearer token. Mirrors what the page does (docs: README "Sign-in handoff").
export async function signIn(mf, base, page, pagePath = '/') {
  const jar = {}
  const keep = r => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'), i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1) } }
  const call = (path, init = {}) => mf.dispatchFetch(base + path, { redirect: 'manual', ...init, headers: { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), ...init.headers } })
  const rel = loc => { const u = new URL(loc, base); return u.pathname + u.search }
  // the page navigates to /api/signin/start (a top-level visit), so the OAuth state cookie is first-party
  const start = await call('/api/signin/start?provider=fake&return=' + encodeURIComponent(page + pagePath)); keep(start)
  const authz = await fetch(start.headers.get('location'), { redirect: 'manual' })
  const cb = await call(rel(authz.headers.get('location'))); keep(cb)
  const done = await call(rel(cb.headers.get('location')))
  const ott = decodeURIComponent(done.headers.get('location').split('#ott=')[1])
  const v = await mf.dispatchFetch(base + '/api/auth/one-time-token/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: page }, body: JSON.stringify({ token: ott }) })
  return v.headers.get('set-auth-token')
}
