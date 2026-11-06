import { betterAuth } from 'better-auth'
import { bearer, genericOAuth, oneTimeToken } from 'better-auth/plugins'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'

export const allowedOrigins = env => String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)

// Better Auth options for one request (the D1 binding exists only per request). `database` is injectable so the schema can be
// generated and migrated in tests. Real Discord and Google use `socialProviders` once their secrets are set; the generic provider
// below exists so the whole sign-in and handoff can be tested against a fake provider with no real account (FAKE_OAUTH_URL).
export function authOptions(env, database) {
  const options = {
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    database: { db: new Kysely({ dialect: new D1Dialect({ database: database ?? env.DB }) }), type: 'sqlite' },
    trustedOrigins: allowedOrigins(env),
    // Per-IP limits on the auth endpoints. Stored in D1 because Worker isolates share no memory.
    // Cloudflare puts the client address in this header; without it the limit would be one shared bucket for everyone.
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30 },
    // Linking only when the provider says the email is verified (the default). Do not add trustedProviders.
    plugins: [
      bearer({ requireSignature: true }), // only the signed token the sign-in handed out is accepted, never a bare session id
      // The page cannot read a redirect's headers, so /api/signin/done mints this token server-side and puts it in the URL hash.
      oneTimeToken({ disableClientRequest: true, storeToken: 'hashed', expiresIn: 2 }),
    ],
  }
  const generic = []
  if (env.FAKE_OAUTH_URL) generic.push({ providerId: 'fake', clientId: 'cid', clientSecret: 'secret', scopes: ['openid', 'email'],
    authorizationUrl: env.FAKE_OAUTH_URL + '/authorize', tokenUrl: env.FAKE_OAUTH_URL + '/token', userInfoUrl: env.FAKE_OAUTH_URL + '/userinfo' })
  if (generic.length) options.plugins.push(genericOAuth({ config: generic }))
  if (env.DISCORD_CLIENT_ID) options.socialProviders = { ...options.socialProviders, discord: { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET, scope: ['identify', 'email'] } }
  if (env.GITHUB_CLIENT_ID) options.socialProviders = { ...options.socialProviders, github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
  if (env.GOOGLE_CLIENT_ID) options.socialProviders = { ...options.socialProviders, google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
  return options
}

export const makeAuth = env => betterAuth(authOptions(env))
