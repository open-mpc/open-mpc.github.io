// Aggregate counts for every plugin, in three grouped queries (one D1 batch). Hidden reports and hidden users never count, and a
// person counts once per plugin however many reports they filed (docs/COMMUNITY_SIGNALS.md).
export async function readCounts(db) {
  const [all, byVersion, likes] = await db.batch([
    db.prepare(`SELECT r.plugin_id AS id, COUNT(DISTINCT r.user_id) AS n
                FROM working_reports r JOIN "user" u ON u.id = r.user_id
                WHERE r.hidden = 0 AND u.hidden = 0 GROUP BY r.plugin_id`),
    db.prepare(`SELECT r.plugin_id AS id, r.version AS version, COUNT(DISTINCT r.user_id) AS n
                FROM working_reports r JOIN "user" u ON u.id = r.user_id
                WHERE r.hidden = 0 AND u.hidden = 0 GROUP BY r.plugin_id, r.version`),
    db.prepare(`SELECT l.plugin_id AS id, COUNT(*) AS n
                FROM likes l JOIN "user" u ON u.id = l.user_id
                WHERE u.hidden = 0 GROUP BY l.plugin_id`),
  ])
  const out = {}
  const slot = id => { if (!out[id]) out[id] = { working: 0, likes: 0, versions: {} }; return out[id] }
  for (const r of all.results) slot(r.id).working = r.n
  for (const r of byVersion.results) slot(r.id).versions[r.version] = r.n
  for (const r of likes.results) slot(r.id).likes = r.n
  return out
}

// One plugin's community detail for the popup: the same counts plus which devices and OS versions people reported on, and the most
// recent reports. Anonymous by design: no names, no emails, no user ids, and only the date of a report.
export async function readPlugin(db, id) {
  const visible = `FROM working_reports r JOIN "user" u ON u.id = r.user_id WHERE r.plugin_id = ?1 AND r.hidden = 0 AND u.hidden = 0`
  const [total, byVersion, devices, recent, likes] = await db.batch([
    db.prepare(`SELECT COUNT(DISTINCT r.user_id) AS n ${visible}`).bind(id),
    db.prepare(`SELECT r.version AS version, COUNT(DISTINCT r.user_id) AS n ${visible} GROUP BY r.version`).bind(id),
    db.prepare(`SELECT r.device AS device, r.os AS os, COUNT(DISTINCT r.user_id) AS n ${visible} GROUP BY r.device, r.os ORDER BY n DESC, r.device, r.os LIMIT 20`).bind(id),
    db.prepare(`SELECT r.version AS version, r.device AS device, r.os AS os, substr(r.created_at, 1, 10) AS date ${visible} ORDER BY r.created_at DESC, r.id LIMIT 10`).bind(id),
    db.prepare(`SELECT COUNT(*) AS n FROM likes l JOIN "user" u ON u.id = l.user_id WHERE l.plugin_id = ?1 AND u.hidden = 0`).bind(id),
  ])
  const versions = {}
  for (const r of byVersion.results) versions[r.version] = r.n
  return { id, working: total.results[0].n, likes: likes.results[0].n, versions, devices: devices.results, recent: recent.results }
}
