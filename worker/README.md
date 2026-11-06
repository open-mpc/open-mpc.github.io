# openmpc-signals (draft, step 2)

Community signals for the OpenMPC plugin catalog: "reported working" and likes. Design: `docs/COMMUNITY_SIGNALS.md` in
`mpc-vst-plugins`. **Scratch repo until an org repo exists; no real accounts, no deployment.**

Built so far (all offline, fake provider): D1 schema (`0001_auth.sql` generated, `0002_signals.sql`), the public read endpoint, the sign-in handoff (below) and the write endpoints.

`GET /api/counts` returns `{"counts": {"<plugin id>": {"working": N, "likes": N, "versions": {"<version>": N}}}}`, cached 5 minutes,
readable from any origin. `working` is distinct people across versions; `versions` is distinct people per version, so the page picks
the newest version from its own catalog data. Hidden reports and hidden users never count.

```
npm install
npm test        # Miniflare runs the Worker with an in-memory D1; no Cloudflare account needed
```
Tests run offline against the local workerd runtime (compatibility date 2026-08-01, the newest the installed binary supports).
## Sign-in handoff (prototype, tested against a fake OAuth provider only)
Cookies cannot work between `open-mpc.github.io` and the API (different sites), so the page gets a bearer token:
1. Page `POST /api/auth/sign-in/social` (`provider`, `callbackURL` = `/api/signin/done?return=<page origin>`), then goes to the provider.
2. Provider returns to Better Auth's callback, which sets the session cookie on the API host and redirects to `/api/signin/done`.
3. `/api/signin/done` mints a one-time token (2 minutes, stored hashed) server-side and redirects to `<page>/#ott=...`. The return
   origin must be in `ALLOWED_ORIGINS`.
4. The page `POST /api/auth/one-time-token/verify {token}` with no cookie. The response carries `set-auth-token` (exposed by CORS).
5. The page sends `Authorization: Bearer ...` to protected routes (`/api/me` for now). The one-time token works once.
Better Auth's own migrator cannot run on D1 (Kysely introspection uses PRAGMA), so `scripts/gen-auth-schema.mjs` writes
`migrations/0001_auth.sql`; rerun it after upgrading Better Auth. `test/helpers.js` bundles the Worker for Miniflare and patches
one optional `node:sqlite` import for tests only.

## Public reads
`GET /api/counts` (all plugins) and `GET /api/plugin?id=<plugin>`: the same counts plus `devices` (device, OS, people) and `recent` (version,
device, OS, date, newest 10). Anonymous: no names, emails or ids. Cached 5 minutes, readable from any origin.

## Follow a plugin and the personal feed
`POST/DELETE /api/follow {plugin}` (bearer; the first follow also creates the person's feed address), `POST /api/feed/rotate` (a new secret
address, the old one stops at once), `GET /api/me` also returns `follows` and `feedUrl`, and `GET /feed/<token>.xml` (no sign-in: the secret token
is the credential) is an Atom feed of the followed plugins' non-yanked releases, newest first, 50 at most, with the catalog's entry ids. Needs
no mail sender or domain. Limits: 300 follows per person. Deleting the account removes the follows and the token. Migration `0003_follows.sql`.

## Write endpoints (all need a bearer token and an allowed `Origin`)
| Route | Does |
|---|---|
| `GET /api/me` | own name, likes and reports |
| `POST` / `DELETE /api/working` | `{plugin, version, device, os}`: report or withdraw "works on my device"; one per person, plugin, version, device and OS |
| `POST` / `DELETE /api/like` | `{plugin}` |
| `DELETE /api/me` | `{"confirm":"delete my account"}`: hard delete; sessions, likes and reports cascade |
Plugins and versions are checked against the published catalog (`CATALOG_URL`, cached an hour); writes fail closed (503) if it cannot be
read. Per-person daily caps: 30 reports, 200 likes. Better Auth's own per-IP limit (60 s window, 30 requests, stored in D1, address from
`cf-connecting-ip`) covers the auth endpoints; **it is configured but not tested to trip**.

Not yet: real Discord and Google credentials, a deployed D1 database, hiding a report or user (set `hidden` by hand for now),
bearer signature (`requireSignature`), the page changes, a real `wrangler deploy` dry run.
