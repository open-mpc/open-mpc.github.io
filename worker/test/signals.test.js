// Write endpoints with real (fake-provider) sign-ins: reports, likes, own data, deletion, limits and refusals.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { applyMigrations, buildWorker, signIn, startFake } from './helpers.js'

const PAGE = 'https://open-mpc.github.io', BASE = 'http://api.test'
let mf, fake, a, b
const api = (token, method, path, body, origin = PAGE) => mf.dispatchFetch(BASE + path, { method, headers: { origin, ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const counts = async () => (await (await mf.dispatchFetch(BASE + '/api/counts')).json()).counts
const rep = { plugin: 'acid-303', version: '1.1.0', device: 'MPC Live II', os: '3.9.1' }

before(async () => {
  rmSync('.build/d1', { recursive: true, force: true })
  fake = await startFake()
  mf = new Miniflare({ modules: true, scriptPath: await buildWorker('.build/signals.js'), compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], d1Persist: '.build/d1',
    bindings: { BASE_URL: BASE, AUTH_SECRET: 'test-secret-test-secret-test-secret-1234', ALLOWED_ORIGINS: PAGE, FAKE_OAUTH_URL: fake.url, CATALOG_URL: fake.url + '/catalog.json' } })
  await applyMigrations(await mf.getD1Database('DB'))
  a = await signIn(mf, BASE, PAGE)
  fake.profile = { id: 'p2', sub: 'p2', email: 'second@example.test', email_verified: true, name: 'Second' }
  b = await signIn(mf, BASE, PAGE)
})
after(async () => { await mf?.dispose(); fake?.close() })

test('two sign-ins are two people with working tokens', async () => {
  assert.ok(a && b && a !== b)
  assert.equal((await (await api(a, 'GET', '/api/me')).json()).user.name, 'Fan')
  assert.equal((await (await api(b, 'GET', '/api/me')).json()).user.name, 'Second')
})

test('a report counts once per person and shows up in /api/me', async () => {
  const r1 = await api(a, 'POST', '/api/working', rep)
  assert.deepEqual(await r1.json(), { ok: true, created: true })
  assert.deepEqual(await (await api(a, 'POST', '/api/working', rep)).json(), { ok: true, created: false }) // same report again
  await api(a, 'POST', '/api/working', { ...rep, version: '1.0.0' })                                       // same person, other version
  await api(b, 'POST', '/api/working', rep)
  const c = (await counts())['acid-303']
  assert.equal(c.working, 2); assert.deepEqual(c.versions, { '1.0.0': 1, '1.1.0': 2 })
  const me = await (await api(a, 'GET', '/api/me')).json()
  assert.equal(me.reports.length, 2)
})

test('a report can be withdrawn', async () => {
  await api(b, 'DELETE', '/api/working', rep)
  assert.equal((await counts())['acid-303'].working, 1)
})

test('likes: like, like again, unlike', async () => {
  await api(a, 'POST', '/api/like', { plugin: 'acid-303' }); await api(a, 'POST', '/api/like', { plugin: 'acid-303' }); await api(b, 'POST', '/api/like', { plugin: 'acid-303' })
  assert.equal((await counts())['acid-303'].likes, 2)
  assert.deepEqual((await (await api(a, 'GET', '/api/me')).json()).likes, ['acid-303'])
  await api(b, 'DELETE', '/api/like', { plugin: 'acid-303' })
  assert.equal((await counts())['acid-303'].likes, 1)
})

test('unknown plugin, unknown version and malformed input are refused', async () => {
  assert.equal((await api(a, 'POST', '/api/like', { plugin: 'nope' })).status, 400)
  assert.equal((await api(a, 'POST', '/api/working', { ...rep, version: '9.9.9' })).status, 400)
  assert.equal((await api(a, 'POST', '/api/working', { ...rep, device: '<script>' })).status, 400)
  assert.equal((await api(a, 'POST', '/api/working', { ...rep, os: '' })).status, 400)
  assert.equal((await api(a, 'POST', '/api/working', 'not an object')).status, 400)
  assert.equal((await mf.dispatchFetch(BASE + '/api/like', { method: 'POST', headers: { origin: PAGE, authorization: 'Bearer ' + a }, body: 'x'.repeat(5000) })).status, 413)
})

test('no token, a bad token or a foreign origin is refused', async () => {
  assert.equal((await api(null, 'POST', '/api/like', { plugin: 'acid-303' })).status, 401)
  assert.equal((await api('garbage', 'POST', '/api/like', { plugin: 'acid-303' })).status, 401)
  assert.equal((await api(a, 'POST', '/api/like', { plugin: 'acid-303' }, 'https://evil.example')).status, 403)
  assert.equal((await mf.dispatchFetch(BASE + '/api/like', { method: 'POST', headers: { authorization: 'Bearer ' + a }, body: '{}' })).status, 403)
})

test('the daily report limit applies per person', async () => {
  fake.profile = { id: 'p3', sub: 'p3', email: 'third@example.test', email_verified: true, name: 'Third' }
  const c = await signIn(mf, BASE, PAGE)
  const db = await mf.getD1Database('DB')
  const id = (await (await api(c, 'GET', '/api/me')).json()).user.id
  for (let i = 0; i < 30; i++) await db.prepare('INSERT INTO working_reports (id, user_id, plugin_id, version, device, os) VALUES (?, ?, ?, ?, ?, ?)').bind('x' + i, id, 'acid-303', '1.0.0', 'Dev ' + i, '1').run()
  const over = await api(c, 'POST', '/api/working', rep)
  assert.equal(over.status, 429)
})

test('writes fail closed when the catalog cannot be read', async () => {
  // A second worker on the same database (same persisted state) whose catalog address is dead; the token from the first still works.
  const dead = new Miniflare({ modules: true, scriptPath: '.build/signals.js', compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], d1Persist: '.build/d1',
    bindings: { BASE_URL: BASE, AUTH_SECRET: 'test-secret-test-secret-test-secret-1234', ALLOWED_ORIGINS: PAGE, FAKE_OAUTH_URL: fake.url, CATALOG_URL: 'http://127.0.0.1:1/catalog.json' } })
  try {
    const r = await dead.dispatchFetch(BASE + '/api/like', { method: 'POST', headers: { origin: PAGE, authorization: 'Bearer ' + b, 'content-type': 'application/json' }, body: JSON.stringify({ plugin: 'acid-303' }) })
    assert.equal(r.status, 503)
  } finally { await dead.dispose() }
})

test('deleting the account removes it, its reports, likes and token', async () => {
  const before = (await counts())['acid-303']
  assert.equal((await api(a, 'DELETE', '/api/me', {})).status, 400)                   // needs the confirmation
  assert.equal((await api(a, 'DELETE', '/api/me', { confirm: 'delete my account' })).status, 200)
  assert.equal((await api(a, 'GET', '/api/me')).status, 401)                          // the session went with it
  const after = (await counts())['acid-303']
  assert.ok(after.working < before.working && after.likes < before.likes, JSON.stringify({ before, after }))
})

test('maintainer hiding: needs the secret, drops counts, can be undone', async () => {
  const ADMIN = 'admin-secret-admin-secret-1234567'
  const adm = new Miniflare({ modules: true, scriptPath: '.build/signals.js', compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], d1Persist: '.build/d1',
    bindings: { BASE_URL: BASE, AUTH_SECRET: 'test-secret-test-secret-test-secret-1234', ALLOWED_ORIGINS: PAGE, FAKE_OAUTH_URL: fake.url, CATALOG_URL: fake.url + '/catalog.json', ADMIN_TOKEN: ADMIN } })
  const call = (path, init = {}) => adm.dispatchFetch(BASE + path, { ...init, headers: { 'x-admin-token': ADMIN, 'content-type': 'application/json', ...init.headers } })
  try {
    assert.equal((await adm.dispatchFetch(BASE + '/api/admin/reports')).status, 404)                          // no secret
    assert.equal((await adm.dispatchFetch(BASE + '/api/admin/reports', { headers: { 'x-admin-token': 'wrong' } })).status, 404)
    assert.equal((await mf.dispatchFetch(BASE + '/api/admin/reports', { headers: { 'x-admin-token': ADMIN } })).status, 404) // a worker with no secret set has no admin
    await api(b, 'POST', '/api/working', rep)                                                                 // user two reports again
    const before = (await counts())['acid-303'].working
    const mine = (await (await call('/api/admin/reports')).json()).reports.find(r => r.email === 'second@example.test' && r.plugin_id === 'acid-303')
    assert.ok(mine)
    const hide = (body) => call('/api/admin/hide', { method: 'POST', body: JSON.stringify(body) })
    await hide({ report: mine.id })
    assert.equal((await counts())['acid-303'].working, before - 1)
    await hide({ report: mine.id, hidden: false })
    assert.equal((await counts())['acid-303'].working, before)
    assert.equal((await (await hide({ user: 'second@example.test' })).json()).changed, 1)                      // by email
    assert.equal((await counts())['acid-303'].working, before - 1)
    await hide({ user: mine.user_id, hidden: false })                                                          // by id
    assert.equal((await counts())['acid-303'].working, before)
    assert.equal((await hide({})).status, 400)
  } finally { await adm.dispose() }
})

test('auth endpoints are rate limited per client address', async () => {
  const hit = ip => mf.dispatchFetch(BASE + '/api/auth/sign-in/social', { method: 'POST', headers: { origin: PAGE, 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: '{}' })
  let limited = 0
  for (let i = 0; i < 40; i++) if ((await hit('203.0.113.9')).status === 429) limited++
  assert.ok(limited > 0, 'the 31st request in a minute from one address should be refused')
  assert.notEqual((await hit('203.0.113.10')).status, 429)                      // another address is unaffected
})
