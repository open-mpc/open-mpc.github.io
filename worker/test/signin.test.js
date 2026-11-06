// Sign-in handoff against a fake OAuth provider, with no real account: provider redirect -> our callback -> one-time token in the
// URL hash -> page exchanges it for a bearer token with a cookie-less fetch -> bearer token reaches a protected route.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { applyMigrations, buildWorker } from './helpers.js'
import { Miniflare } from 'miniflare'

const PAGE = 'https://open-mpc.github.io', BASE = 'http://api.test'
let mf, provider, fakeUrl, env
const profile = { id: 'p1', sub: 'p1', email: 'fan@example.test', email_verified: true, name: 'Fan' }

before(async () => {
  provider = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/authorize') { res.writeHead(302, { location: u.searchParams.get('redirect_uri') + '?code=abc&state=' + u.searchParams.get('state') }); return res.end() }
    if (u.pathname === '/token') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600 })) }
    if (u.pathname === '/userinfo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(profile)) }
    res.writeHead(404); res.end()
  })
  await new Promise(r => provider.listen(0, '127.0.0.1', r))
  fakeUrl = 'http://127.0.0.1:' + provider.address().port
  env = { BASE_URL: BASE, AUTH_SECRET: 'test-secret-test-secret-test-secret-1234', ALLOWED_ORIGINS: PAGE, FAKE_OAUTH_URL: fakeUrl, GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' }
  const script = await buildWorker()
  mf = new Miniflare({ modules: true, scriptPath: script, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: env })
  const d1 = await mf.getD1Database('DB')
  await applyMigrations(d1)
})
after(async () => { await mf?.dispose(); provider?.close() })

const jar = {}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ')
const keep = r => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1) } }
const call = (path, init = {}) => mf.dispatchFetch(BASE + path, { redirect: 'manual', ...init, headers: { cookie: cookieHeader(), ...init.headers } })

let ott
test('sign in with the fake provider ends on the page with a one-time token in the hash', async () => {
  const start = await call('/api/auth/sign-in/social', { method: 'POST', headers: { 'content-type': 'application/json', origin: PAGE },
    body: JSON.stringify({ provider: 'fake', callbackURL: BASE + '/api/signin/done?return=' + encodeURIComponent(PAGE + '/') }) })
  keep(start)
  const startText = await start.text()
  assert.equal(start.status, 200, start.status + ' ' + startText + ' ' + JSON.stringify([...start.headers]))
  const { url } = JSON.parse(startText)
  const authz = await fetch(url, { redirect: 'manual' })                      // the fake provider approves at once
  const cb = await call(new URL(authz.headers.get('location')).pathname + new URL(authz.headers.get('location')).search)
  keep(cb)
  assert.equal(cb.status, 302, 'callback should redirect: ' + await cb.text())
  const done = await call(new URL(cb.headers.get('location'), BASE).pathname + new URL(cb.headers.get('location'), BASE).search)
  assert.equal(done.status, 302, 'cb location ' + cb.headers.get('location') + ' | done ' + done.status + ' ' + (await done.clone().text()).slice(0, 300))
  const loc = done.headers.get('location')
  assert.ok(loc.startsWith(PAGE + '/#ott='), loc)
  ott = decodeURIComponent(loc.split('#ott=')[1])
})

let bearer
test('the page exchanges the token for a bearer token with no cookie, and the header is readable cross-origin', async () => {
  const r = await mf.dispatchFetch(BASE + '/api/auth/one-time-token/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: PAGE }, body: JSON.stringify({ token: ott }) })
  assert.equal(r.status, 200, await r.clone().text())
  assert.equal(r.headers.get('access-control-allow-origin'), PAGE)
  assert.match(r.headers.get('access-control-expose-headers'), /set-auth-token/)
  bearer = r.headers.get('set-auth-token')
  assert.ok(bearer, 'bearer token header present')
})

test('the token is single use', async () => {
  const r = await mf.dispatchFetch(BASE + '/api/auth/one-time-token/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: PAGE }, body: JSON.stringify({ token: ott }) })
  assert.equal(r.status, 400)
})

test('the bearer token authenticates a protected route; no token does not', async () => {
  const ok = await mf.dispatchFetch(BASE + '/api/me', { headers: { authorization: 'Bearer ' + bearer, origin: PAGE } })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).user.name, 'Fan')
  assert.equal((await mf.dispatchFetch(BASE + '/api/me', { headers: { origin: PAGE } })).status, 401)
})

test('a return address outside the allow-list is refused', async () => {
  const r = await call('/api/signin/done?return=' + encodeURIComponent('https://evil.example'))
  assert.equal(r.status, 400)
})

test('the page keeps its own path (the old address lives under /mpc-vst-plugins/)', async () => {
  const r = await call('/api/signin/done?return=' + encodeURIComponent(PAGE + '/mpc-vst-plugins/?signals=1#x'))
  assert.equal(r.status, 302)
  assert.ok(/^https:\/\/open-mpc\.github\.io\/mpc-vst-plugins\/#(ott|signin)=/.test(r.headers.get('location')), r.headers.get('location')) // path kept, query and hash from `return` dropped
})
test('a malformed return address is refused', async () => {
  assert.equal((await call('/api/signin/done?return=' + encodeURIComponent('not a url'))).status, 400)
  assert.equal((await call('/api/signin/done')).status, 400)
})

// The page must START sign-in by navigating here (not with a cross-site fetch): the state cookie has to be set on our own site.
test('/api/signin/start sends the browser to the provider and sets the state cookie', async () => {
  const r = await mf.dispatchFetch(BASE + '/api/signin/start?provider=fake&return=' + encodeURIComponent(PAGE + '/mpc-vst-plugins/'), { redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.ok(r.headers.get('location').startsWith(fakeUrl + '/authorize'), r.headers.get('location'))
  assert.ok((r.headers.getSetCookie?.() ?? []).length > 0, 'a state cookie is set')
})
test('/api/signin/start refuses an unknown return address, a provider that is not set up, and odd provider names', async () => {
  const go = q => mf.dispatchFetch(BASE + '/api/signin/start?' + q, { redirect: 'manual' })
  assert.equal((await go('provider=fake&return=' + encodeURIComponent('https://evil.example/'))).status, 400)
  assert.equal((await go('provider=discord&return=' + encodeURIComponent(PAGE + '/'))).status, 400)   // no Discord secrets in the test env
  assert.equal((await go('provider=../x&return=' + encodeURIComponent(PAGE + '/'))).status, 400)
  assert.equal((await go('provider=fake')).status, 400)
})

test('GitHub is offered when its secrets are set', async () => {
  const r = await mf.dispatchFetch(BASE + '/api/signin/start?provider=github&return=' + encodeURIComponent(PAGE + '/'), { redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.ok(r.headers.get('location').startsWith('https://github.com/login/oauth/authorize'), r.headers.get('location'))
  assert.match(r.headers.get('location'), /scope=[^&]*user%3Aemail|scope=[^&]*user:email/)
})
