import { readCatalog } from './catalog.js'

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const httpsOnly = u => (/^https:\/\//.test(String(u ?? '')) ? String(u) : '')

export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')   // 32 URL-safe characters
}

// The person's own Atom feed: every non-yanked release of the plugins they follow, newest first (50 at most). Entry ids match the catalog's feed.xml
// (tag:mpc-vst-catalog,2026:<id>@<version>), so a reader that also follows that feed shows each release once.
export async function feedRoute(env, token) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null
  const row = await env.DB.prepare('SELECT user_id FROM feed_tokens WHERE token = ?').bind(token).first()
  if (!row) return null
  const [follows, plugins] = await Promise.all([
    env.DB.prepare('SELECT plugin_id FROM follows WHERE user_id = ?').bind(row.user_id).all(), readCatalog(env)])
  if (!plugins) return { error: 503 }
  const mine = new Set(follows.results.map(r => r.plugin_id)), items = []
  for (const p of plugins) if (mine.has(p.id)) for (const v of p.versions ?? []) if (!v.yanked && v.date && v.version) items.push({ p, v })
  items.sort((a, b) => (b.v.date + b.p.name).localeCompare(a.v.date + a.p.name) || b.v.version.localeCompare(a.v.version, undefined, { numeric: true }))
  const top = items.slice(0, 50)
  const out = ['<?xml version="1.0" encoding="utf-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">', '<title>Open MPC: updates to plugins you follow</title>',
    `<id>tag:mpc-vst-catalog,2026:follow/${esc(token.slice(0, 8))}</id>`, `<updated>${top.length ? top[0].v.date + 'T00:00:00Z' : '1970-01-01T00:00:00Z'}</updated>`,
    `<link rel="self" href="${esc(env.BASE_URL)}/feed/${esc(token)}.xml"/>`]
  for (const { p, v } of top) {
    const note = String(v.notes ?? '').split(/\s+/).join(' ').slice(0, 500) || p.summary || ''
    out.push(`<entry><title>${esc(p.name)} ${esc(v.version)}${v.channel === 'beta' ? ' (beta)' : ''}</title><id>tag:mpc-vst-catalog,2026:${esc(p.id)}@${esc(v.version)}</id>` +
      `<updated>${esc(v.date)}T00:00:00Z</updated><link href="${esc(httpsOnly(v.url) || httpsOnly(v.source_url))}"/><author><name>${esc(p.author)}</name></author><summary>${esc(note)}</summary></entry>`)
  }
  out.push('</feed>')
  return { xml: out.join('\n') + '\n' }
}
