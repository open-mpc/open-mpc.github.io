import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Miniflare } from 'miniflare'
import { applyMigrations, buildWorker } from './helpers.js'

let mf, db
before(async () => {
  mf = new Miniflare({ modules: true, scriptPath: await buildWorker('.build/counts.js'), compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'] })
  db = await mf.getD1Database('DB')
  await applyMigrations(db)
})
after(async () => { await mf?.dispose() })

const user = (id, hidden = 0) => db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, hidden) VALUES (?, ?, ?, 1, ?, ?, ?)').bind(id, id, id + '@example.test', '2026-11-05', '2026-11-05', hidden).run()
const report = (id, user_id, plugin, version, hidden = 0) => db.prepare('INSERT INTO working_reports (id, user_id, plugin_id, version, device, os, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, user_id, plugin, version, 'MPC Live II', '3.9.1', hidden).run()
const get = async () => { const r = await mf.dispatchFetch('http://x/api/counts'); return { r, body: await r.json() } }

test('empty database gives an empty object, cached and public', async () => {
  const { r, body } = await get()
  assert.equal(r.status, 200)
  assert.deepEqual(body, { counts: {} })
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  assert.match(r.headers.get('cache-control'), /max-age=300/)
})

test('counts distinct people across versions, and per version', async () => {
  await user('u1'); await user('u2'); await user('u3')
  await report('r1', 'u1', 'acid-303', '1.0.0')
  await report('r2', 'u1', 'acid-303', '1.1.0') // same person, new version: still one person overall
  await report('r3', 'u2', 'acid-303', '1.1.0')
  await db.prepare('INSERT INTO likes (plugin_id, user_id) VALUES (?, ?)').bind('acid-303', 'u1').run()
  await db.prepare('INSERT INTO likes (plugin_id, user_id) VALUES (?, ?)').bind('acid-303', 'u3').run()
  const { body } = await get()
  assert.deepEqual(body.counts['acid-303'], { working: 2, likes: 2, versions: { '1.0.0': 1, '1.1.0': 2 } })
})

test('hidden reports and hidden users never count', async () => {
  await user('bad', 1)
  await report('r4', 'bad', 'acid-303', '1.1.0')
  await db.prepare('INSERT INTO likes (plugin_id, user_id) VALUES (?, ?)').bind('acid-303', 'bad').run()
  await user('u4'); await report('r5', 'u4', 'other', '2.0.0', 1) // hidden report
  const { body } = await get()
  assert.equal(body.counts['acid-303'].working, 2)
  assert.equal(body.counts['acid-303'].likes, 2)
  assert.equal(body.counts.other, undefined)
})

test('plugin detail: breakdown, recent reports, nothing that identifies anyone', async () => {
  const r = await mf.dispatchFetch('http://x/api/plugin?id=acid-303')
  const body = await r.json(), text = JSON.stringify(body)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.match(r.headers.get('cache-control'), /max-age=300/)
  assert.equal(body.working, 2); assert.equal(body.likes, 2); assert.deepEqual(body.versions, { '1.0.0': 1, '1.1.0': 2 })
  assert.deepEqual(body.devices, [{ device: 'MPC Live II', os: '3.9.1', n: 2 }])           // two people, one device and OS
  assert.ok(body.recent.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(body.recent[0].date))
  assert.ok(!/example\.test|"id":"u|email|user_id|name/i.test(text), text)               // no email, user id or name
  assert.deepEqual((await (await mf.dispatchFetch('http://x/api/plugin?id=nothing-here')).json()).working, 0)
  assert.equal((await mf.dispatchFetch('http://x/api/plugin?id=Bad%20Id')).status, 400)
  assert.equal((await mf.dispatchFetch('http://x/api/plugin?id=acid-303', { method: 'POST' })).status, 405)
})

test('one report per person, plugin, version, device and OS', async () => {
  await assert.rejects(report('dup', 'u1', 'acid-303', '1.0.0'))
})

test('one email is one person', async () => {
  await assert.rejects(user('u1x').then(() => db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (\'u1y\', \'x\', \'u1x@example.test\', 1, \'d\', \'d\')').run()))
})

test('deleting a user removes their reports and likes', async () => {
  await db.prepare('PRAGMA foreign_keys = ON').run()
  await db.prepare('DELETE FROM "user" WHERE id = \'u2\'').run()
  const { body } = await get()
  assert.equal(body.counts['acid-303'].working, 1)
})

test('other methods and paths are refused', async () => {
  assert.equal((await mf.dispatchFetch('http://x/api/counts', { method: 'POST' })).status, 405)
  assert.equal((await mf.dispatchFetch('http://x/nope')).status, 404)
  assert.equal((await mf.dispatchFetch('http://x/api/counts', { method: 'OPTIONS' })).status, 204)
})

test('count queries use the indexes (no full scan of the reports table)', async () => {
  for (const sql of ['SELECT plugin_id, COUNT(DISTINCT user_id) FROM working_reports WHERE hidden = 0 GROUP BY plugin_id', 'SELECT plugin_id, COUNT(*) FROM likes GROUP BY plugin_id']) {
    const plan = (await db.prepare('EXPLAIN QUERY PLAN ' + sql).all()).results.map(r => r.detail).join(' | ')
    assert.match(plan, /USING (COVERING )?INDEX/, plan)
  }
})
