import { readCounts, readPlugin } from './counts.js'
import { allowedOrigins, makeAuth } from './auth.js'
import { Refusal, signalRoute } from './signals.js'
import { adminRoute } from './admin.js'
import { feedRoute } from './feed.js'

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

// Credentialed calls accept only the catalog page origins. The bearer token is exposed to the page through this header list.
function cors(request, env) {
  const origin = request.headers.get('origin')
  if (!origin || !allowedOrigins(env).includes(origin)) return {}
  return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-expose-headers': 'set-auth-token' }
}
const withHeaders = (response, extra) => { const r = new Response(response.body, response); for (const [k, v] of Object.entries(extra)) r.headers.set(k, v); return r }

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/counts') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' } })
      if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, { allow: 'GET, OPTIONS' })
      try {
        // Public read: any origin, cached for 5 minutes so card views do not each hit D1. The page treats any failure as "no counts".
        return json({ counts: await readCounts(env.DB) }, 200, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' })
      } catch {
        return json({ error: 'Counts are unavailable.' }, 503, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
      }
    }
    if (url.pathname === '/api/plugin') {
      const id = url.searchParams.get('id') || ''
      if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, { allow: 'GET' })
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return json({ error: 'Check the plugin id.' }, 400, { 'access-control-allow-origin': '*' })
      try { return json(await readPlugin(env.DB, id), 200, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' }) }
      catch { return json({ error: 'Detail is unavailable.' }, 503, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }) }
    }
    const fm = url.pathname.match(/^\/feed\/([A-Za-z0-9_-]+)\.xml$/)
    if (fm) {   // a person's own feed: the secret token in the address is the only credential
      if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, { allow: 'GET' })
      const f = await feedRoute(env, fm[1]).catch(() => ({ error: 503 }))
      if (!f) return json({ error: 'Not found.' }, 404)
      if (f.error) return json({ error: 'The feed is unavailable.' }, f.error, { 'cache-control': 'no-store' })
      return new Response(f.xml, { headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'private, max-age=600', 'x-robots-tag': 'noindex' } })
    }
    if (!/^\/api\/(auth\/|signin\/|me$|like$|working$|follow$|feed\/rotate$|admin\/)/.test(url.pathname)) return json({ error: 'Not found.' }, 404)
    if (!env.AUTH_SECRET) return json({ error: 'Sign-in is not configured.' }, 503)
    const headers = cors(request, env)
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) return new Response(null, { status: 204, headers })
    if (url.pathname.startsWith('/api/admin/')) { // no CORS headers: only a tool with the secret calls this, never a page
      try { return json(await adminRoute(request, env, url.pathname), 200, { 'cache-control': 'no-store' }) }
      catch (e) { if (e instanceof Refusal) return json({ error: e.message }, e.status); throw e }
    }
    const auth = makeAuth(env)
    if (url.pathname === '/api/signin/start') {
      // The page sends the browser HERE (a normal navigation) instead of calling sign-in with fetch: the "state" cookie that protects the
      // OAuth round trip must be set while the browser is on this site, because a cross-site fetch cannot keep it (github.io and
      // workers.dev are different sites) and the provider's return would fail with state_mismatch.
      const provider = url.searchParams.get('provider') || ''
      let back
      try { const r = new URL(url.searchParams.get('return') || ''); if (allowedOrigins(env).includes(r.origin)) back = r.origin + r.pathname } catch {}
      if (!back || !/^[a-z]{1,16}$/.test(provider)) return json({ error: 'Unknown return address or provider.' }, 400)
      const res = await auth.handler(new Request(url.origin + '/api/auth/sign-in/social', { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(back).origin },
        body: JSON.stringify({ provider, callbackURL: url.origin + '/api/signin/done?return=' + encodeURIComponent(back) }) }))
      const to = res.ok ? (await res.json().catch(() => ({}))).url : null
      if (typeof to !== 'string') return json({ error: 'This sign-in is not available.' }, 400)
      const out = new Headers({ location: to, 'cache-control': 'no-store' })
      for (const c of res.headers.getSetCookie?.() ?? []) out.append('set-cookie', c)
      return new Response(null, { status: 302, headers: out })
    }
    if (url.pathname === '/api/signin/done') {
      // OAuth lands here with the session cookie (first-party at this moment). Trade it for a one-time token and send the browser
      // back to the page; the page exchanges the token for a bearer token with a plain fetch, no cookie involved.
      // `return` is the page's own address (origin + path, e.g. https://sd88me.github.io/mpc-vst-plugins/): its origin must be on the allow-list.
      let back
      try { const r = new URL(url.searchParams.get('return') || ''); if (allowedOrigins(env).includes(r.origin)) back = r.origin + r.pathname } catch {}
      if (!back) return json({ error: 'Unknown return address.' }, 400)
      const { token } = await auth.api.generateOneTimeToken({ headers: request.headers }).catch(() => ({}))
      return new Response(null, { status: 302, headers: { location: back + (token ? '#ott=' + encodeURIComponent(token) : '#signin=failed'), 'cache-control': 'no-store' } })
    }
    if (/^\/api\/(me|like|working|follow|feed\/rotate)$/.test(url.pathname)) {
      try { return json(await signalRoute(request, env, auth, url.pathname), 200, { ...headers, 'cache-control': 'no-store' }) }
      catch (e) { if (e instanceof Refusal) return json({ error: e.message }, e.status, headers); throw e }
    }
    if (url.pathname.startsWith('/api/auth/')) return withHeaders(await auth.handler(request), headers)
    return json({ error: 'Not found.' }, 404)
  },
}
