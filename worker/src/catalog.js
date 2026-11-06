// Which plugins and versions exist: read from the published catalog (env.CATALOG_URL, e.g. https://open-mpc.github.io/catalog.json),
// cached by Cloudflare for an hour. Reports and likes for anything else are refused, so nobody can fill the tables with made-up ids.
// Returns Map<plugin id, Set<version>>, or null if the catalog cannot be read (writes then fail closed).
export async function readCatalog(env) {
  try {
    const r = await fetch(env.CATALOG_URL, { cf: { cacheTtl: 3600, cacheEverything: true } })
    if (!r.ok) return null
    const data = await r.json()
    const plugins = (data.plugins ?? []).filter(p => p && typeof p.id === 'string')
    return plugins.length ? plugins : null
  } catch { return null }
}
export async function knownPlugins(env) {
  const plugins = await readCatalog(env)
  if (!plugins) return null
  return new Map(plugins.map(p => [p.id, new Set((p.versions ?? []).map(v => v.version).filter(Boolean))]))
}
