# Setup you do by hand (accounts and secrets)

Everything below needs an account only you can create. Use an org-owned email (not a personal one) for Cloudflare, the Discord
app and the Google project, so someone else can take over later. Steps were written from the providers' docs on 2026-11-05;
their consoles change, so treat button names as approximate. **None of this has been run against real Discord, Google or Cloudflare.**

Order: 0 (terminal) > 1 (Cloudflare) > 2 (Discord) > 3 (Google) > 3b (GitHub) > 4 (secrets) > 5 (tell Claude the address) > 6 (try it).
Steps 2 and 3 need the Worker address from step 1, so do 1 first.

## 0. Where to type the commands
All commands are typed in the **WSL terminal** (the same Linux terminal Claude Code runs in), in this folder:

```
cd ~/openmpc-signals
```

- Node and npm are already installed there (`node -v` prints v22, `npm -v` prints 9). **You do not need to run `npm install`
  again**: the `node_modules` folder is already here. If it is ever missing or you moved the folder, run `npm install` in this folder
  (it reads `package.json` and downloads the libraries; it takes about a minute).
- `npx wrangler ...` runs Cloudflare's command line tool (`wrangler`) that `npm install` put in `node_modules`. Nothing to install globally.
- Check it works: `npx wrangler --version` prints a version number (4.x).
- If you are on Windows and WSL is not what you normally use: open "Ubuntu" (or whatever WSL distro you have) from the Start menu first.
- A line starting with `#` below is a comment, do not type it. Text in `<angle brackets>` is something you replace.

## 1. Cloudflare (free plan is enough at our size)
1. Go to https://dash.cloudflare.com/sign-up and create an account (no domain and no card needed). Verify the email.
2. In the terminal: `cd ~/openmpc-signals`, then `npx wrangler login`.
   It prints a long link and tries to open your browser. If no browser opens, copy the link into one by hand. Click **Allow**.
   The terminal then says "Successfully logged in". (Check with `npx wrangler whoami`.)
3. Create the database: `npx wrangler d1 create signals`.
   It prints a block containing `"database_id": "xxxxxxxx-xxxx-..."`. Open `wrangler.jsonc`, find `d1_databases`, and paste that id
   as the value of `database_id` (replace the placeholder). Save.
4. Create the tables: `npx wrangler d1 migrations apply signals --remote`. Answer `y` when it asks. It applies 3 migrations
   (0001_auth, 0002_signals, 0003_follows).
5. First deploy: `npx wrangler deploy`.
   - It may ask you to choose a **workers.dev subdomain** (a name for your account's addresses, for example `open-mpc`). Pick one.
   - It prints the address, like `https://openmpc-signals.open-mpc.workers.dev`. **That is your BASE_URL. Write it down.**
6. Put the address in `wrangler.jsonc` as the value of `BASE_URL` (replace `https://openmpc-signals.REPLACE-ME.workers.dev`),
   then deploy again: `npx wrangler deploy`.
7. Check it: open `<BASE_URL>/api/counts` in a browser. You should see `{"counts":{}}`. (Errors about auth secrets are normal
   until step 4 below.)

## 2. Discord application
1. Go to https://discord.com/developers/applications and log in. Click **New Application**, name it "OpenMPC catalog", accept the terms.
2. Left menu **OAuth2**. Copy the **Client ID** (shown on that page) into a notes file for now.
3. Click **Reset Secret** (under Client Secret), confirm, and copy the secret that appears. It is shown once. Put it in your notes file.
4. Under **Redirects** click **Add Redirect** and paste exactly `<BASE_URL>/api/auth/callback/discord`
   (for example `https://openmpc-signals.open-mpc.workers.dev/api/auth/callback/discord`). Click **Save Changes**.
5. Nothing else is needed. The Worker asks Discord for the `identify` and `email` permissions by itself.

## 3. Google OAuth
1. Go to https://console.cloud.google.com and sign in with the org Google account. Top bar > project picker > **New project**,
   name "OpenMPC catalog", Create, then make sure it is the selected project.
2. Menu > **APIs & Services** > **OAuth consent screen** (it may be called **Google Auth Platform**; click **Get started**).
   - App name: OpenMPC catalog. User support email: the org address.
   - Audience / user type: **External**.
   - Contact email: the org address. Agree, Create.
3. Under **Data Access** (or "Scopes") add only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. These basic scopes do not
   need Google's app verification.
4. Under **Audience** click **Publish app** so it says **In production**. Left in Testing it is capped at 100 test users and
   the sign-ins expire after 7 days.
5. Menu > **Credentials** (or **Clients**) > **Create credentials** > **OAuth client ID** > Application type **Web application**.
   Under **Authorized redirect URIs** add exactly `<BASE_URL>/api/auth/callback/google`. Create.
6. Copy the **Client ID** and **Client secret** into your notes file.

## 3b. GitHub (optional third sign-in)
1. Go to https://github.com/settings/developers (or, for an org-owned app, the org's Settings > Developer settings) > **OAuth Apps** > **New OAuth App**.
2. Application name: OpenMPC catalog. Homepage URL: `https://open-mpc.github.io/mpc-vst-plugins/`.
3. Authorization callback URL, exactly: `<BASE_URL>/api/auth/callback/github`. Leave Device Flow off. **Register application**.
4. Copy the **Client ID**, then **Generate a new client secret** and copy it (shown once).
5. Add them as the secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (section 4). The Worker asks GitHub for the `user:email` permission.

## 4. Secrets (never commit these, never paste them in chat)
In the terminal, in `~/openmpc-signals`. Each command asks you to paste the value, then press Enter (nothing is shown while you paste):

```
npx wrangler secret put AUTH_SECRET            # paste the output of:  openssl rand -base64 48   (run that on its own line first)
npx wrangler secret put ADMIN_TOKEN            # a random string of 24+ characters: your moderation key, keep it in a password manager
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID       # optional third sign-in, section 3b
npx wrangler secret put GITHUB_CLIENT_SECRET
```

If it asks "Create a new Worker?", answer no and deploy first (step 1.5). Secrets take effect at once, no redeploy needed.
Check: `npx wrangler secret list` shows the 6 names (never the values).

## 5. Point the page at it
Tell Claude the `BASE_URL`. Claude replaces `REPLACE-ME` in `tools/catalog_site/index.template.html` (PR #700, branch
`community-signals-pr` in mpc-vst-plugins) and in `wrangler.jsonc`, rebuilds and retests.

## 6. Try it
Open the catalog with `?signals=1` at the end of the address. Click **Sign in**, try Discord, then sign out and try Google with the same
email (the accounts should join). Press **Works for me** and the heart on a plugin, reload, and check the numbers stay.

If sign-in fails, the usual causes are a redirect address that is not exactly the one above (a trailing slash or `http` instead
of `https` breaks it) or a wrong secret. `npx wrangler tail` shows the Worker's live log while you try again.

## 7. Moderation (when something needs hiding)
```
curl -H "x-admin-token: $ADMIN_TOKEN" $BASE_URL/api/admin/reports                       # newest 100 reports with the person's email
curl -H "x-admin-token: $ADMIN_TOKEN" -d '{"report":"<id>"}' $BASE_URL/api/admin/hide    # hide a report ("hidden": false to restore)
curl -H "x-admin-token: $ADMIN_TOKEN" -d '{"user":"<id or email>"}' $BASE_URL/api/admin/hide
```
Hiding drops the rows from the public counts; nothing is deleted. (Set `ADMIN_TOKEN` in your shell first, or paste it in place of the variable.)

## 8. Before announcing a date
Add a short privacy note to the site (what is stored: provider, provider id, email, the reports and likes; account deletion button),
decide the Discord and Facebook announcement text, and remove the `?signals=1` gate (one line in the page script).
