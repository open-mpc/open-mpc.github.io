// Following plugins: the follow list, the person's secret feed address, its Atom content, rotation and deletion.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { applyMigrations, buildWorker, signIn, startFake } from './helpers.js'

const PAGE = 'https://open-mpc.github.io', BASE = 'http://api.test'
let mf, fake, a, b
const api = (token, method, path, body) => mf.dispatchFetch(BASE + path, { method, headers: { origin: PAGE, ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const me = async t => (await api(t, 'GET', '/api/me')).json()
const tokenOf = url => url.split('/feed/')[1].replace('.xml', '')

before(async () => {
  rmSync('.build/d1follow', { recursive: true, force: true })
  fake = await startFake()
  mf = new Miniflare({ modules: true, scriptPath: await buildWorker('.build/follow.js'), compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], d1Persist: '.build/d1follow',
    bindings: { BASE_URL: BASE, AUTH_SECRET: 'test-secret-test-secret-test-secret-1234', ALLOWED_ORIGINS: PAGE, FAKE_OAUTH_URL: fake.url, CATALOG_URL: fake.url + '/catalog.json' } })
  await applyMigrations(await mf.getD1Database('DB'))
  a = await signIn(mf, BASE, PAGE)
  fake.profile = { id: 'p2', sub: 'p2', email: 'second@example.test', email_verified: true, name: 'Second' }
  b = await signIn(mf, BASE, PAGE)
})
after(async () => { await mf?.dispose(); fake?.close() })

test('nothing followed yet: no follows and no feed address', async () => {
  const m = await me(a)
  assert.deepEqual(m.follows, []); assert.equal(m.feedUrl, null)
})

let feedUrl
test('following a plugin creates the person\'s feed address, the same one for later follows', async () => {
  const r = await (await api(a, 'POST', '/api/follow', { plugin: 'acid-303' })).json()
  assert.equal(r.ok, true); assert.match(r.feedUrl, /^http:\/\/api\.test\/feed\/[A-Za-z0-9_-]{32}\.xml$/)
  feedUrl = r.feedUrl
  assert.equal((await (await api(a, 'POST', '/api/follow', { plugin: 'acid-303' })).json()).feedUrl, feedUrl)   // following twice changes nothing
  const m = await me(a)
  assert.deepEqual(m.follows, ['acid-303']); assert.equal(m.feedUrl, feedUrl)
  assert.deepEqual((await me(b)).follows, [])                                                                  // someone else's list is separate
})

test('the feed lists only followed plugins, newest first, no yanked releases, escaped, with the catalog\'s entry ids', async () => {
  await api(a, 'POST', '/api/follow', { plugin: 'other' })
  const r = await mf.dispatchFetch(feedUrl)
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /application\/atom\+xml/); assert.match(r.headers.get('cache-control'), /private/)
  const xml = await r.text()
  const titles = [...xml.matchAll(/<entry><title>([^<]*)<\/title>/g)].map(m => m[1])
  assert.deepEqual(titles, ['Other 2.0.0 (beta)', 'Acid &lt;303&gt; 1.1.0', 'Acid &lt;303&gt; 1.0.0'])           // 'third' not followed, yanked 1.0.5 gone
  assert.match(xml, /<id>tag:mpc-vst-catalog,2026:acid-303@1\.1\.0<\/id>/)
  assert.match(xml, /<summary>Fixes the click &lt;b&gt;noise&lt;\/b&gt;<\/summary>/)                              // notes: one line, markup escaped
  assert.match(xml, /href="https:\/\/x\/a-1\.1\.0\.zip\?a=1&amp;b=2"/)
  assert.ok(!xml.includes('<b>'))
  assert.ok(xml.startsWith('<?xml'))
  assert.match(xml, new RegExp('rel="self" href="' + feedUrl.replace(/[.]/g, '\\.') + '"'))
})

test('unknown plugin is refused, and unfollowing removes it from the feed', async () => {
  assert.equal((await api(a, 'POST', '/api/follow', { plugin: 'nope' })).status, 400)
  await api(a, 'DELETE', '/api/follow', { plugin: 'other' })
  const xml = await (await mf.dispatchFetch(feedUrl)).text()
  assert.ok(!xml.includes('Other 2.0.0'))
  assert.deepEqual((await me(a)).follows, ['acid-303'])
})

test('following needs a signed-in person and an allowed page', async () => {
  assert.equal((await api(null, 'POST', '/api/follow', { plugin: 'acid-303' })).status, 401)
  assert.equal((await mf.dispatchFetch(BASE + '/api/follow', { method: 'POST', headers: { authorization: 'Bearer ' + a }, body: '{"plugin":"acid-303"}' })).status, 403)
})

test('feed addresses that do not exist are 404, and the feed is read-only', async () => {
  assert.equal((await mf.dispatchFetch(BASE + '/feed/' + 'A'.repeat(32) + '.xml')).status, 404)
  assert.equal((await mf.dispatchFetch(BASE + '/feed/short.xml')).status, 404)
  assert.equal((await mf.dispatchFetch(feedUrl, { method: 'POST' })).status, 405)
})

test('regenerating the address cancels the old one at once', async () => {
  const r = await (await api(a, 'POST', '/api/feed/rotate', {})).json()
  assert.notEqual(r.feedUrl, feedUrl)
  assert.equal((await mf.dispatchFetch(feedUrl)).status, 404)
  const xml = await (await mf.dispatchFetch(r.feedUrl)).text()
  assert.match(xml, /Acid &lt;303&gt; 1\.1\.0/)
  assert.equal((await me(a)).feedUrl, r.feedUrl)
  feedUrl = r.feedUrl
})

test('a person with no follows gets an empty, valid feed', async () => {
  await api(b, 'POST', '/api/follow', { plugin: 'third' }); await api(b, 'DELETE', '/api/follow', { plugin: 'third' })
  const url = (await me(b)).feedUrl
  const xml = await (await mf.dispatchFetch(url)).text()
  assert.ok(xml.includes('<feed') && !xml.includes('<entry>'))
})

test('the follow limit applies', async () => {
  const db = await mf.getD1Database('DB'), id = (await me(b)).user.id
  for (let i = 0; i < 300; i++) await db.prepare('INSERT INTO follows (plugin_id, user_id) VALUES (?, ?)').bind('p' + i, id).run()
  assert.equal((await api(b, 'POST', '/api/follow', { plugin: 'acid-303' })).status, 429)
})

test('deleting the account removes the follows and the feed', async () => {
  assert.equal((await api(a, 'DELETE', '/api/me', { confirm: 'delete my account' })).status, 200)
  assert.equal((await mf.dispatchFetch(feedUrl)).status, 404)
})

test('writes fail closed when the catalog cannot be read, and the feed says so', async () => {
  const dead = new Miniflare({ modules: true, scriptPath: '.build/follow.js', compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], d1Persist: '.build/d1follow',
    bindings: { BASE_URL: BASE, AUTH_SECRET: 'test-secret-test-secret-test-secret-1234', ALLOWED_ORIGINS: PAGE, FAKE_OAUTH_URL: fake.url, CATALOG_URL: 'http://127.0.0.1:1/catalog.json' } })
  try {
    const url = (await me(b)).feedUrl
    assert.equal((await dead.dispatchFetch(url)).status, 503)
    const r = await dead.dispatchFetch(BASE + '/api/follow', { method: 'POST', headers: { origin: PAGE, authorization: 'Bearer ' + b, 'content-type': 'application/json' }, body: '{"plugin":"acid-303"}' })
    assert.equal(r.status, 503)
  } finally { await dead.dispose() }
})
