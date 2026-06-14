# NoaPro Caller

A shared cold-calling tool for a small distributed team. Built as a static front end that talks directly to **Supabase** (Postgres + Auth + Realtime + Storage) — so there is **no server to run and nothing on a PC left on**. It deploys to Vercel or GitHub Pages and costs **£0/month** on the free tiers.

Features: claimable lead queue with live locking (no double-dialling), call-outcome logging, callbacks, CSV import + manual add, a live team dashboard, and a small shared file area.

---

## What you need (all free)

1. A **GitHub** account
2. A **Supabase** account — https://supabase.com
3. A **Vercel** account — https://vercel.com (or use GitHub Pages)

Total setup time: ~20 minutes.

---

## Step 1 — Create the Supabase project

1. supabase.com → **New project**. Pick a name and a strong database password.
2. **Choose a region in the UK/EU** (e.g. London / Frankfurt) — you're storing UK business contact data, so this keeps you GDPR-aligned.
3. Wait for it to finish provisioning (~2 min).

## Step 2 — Create the database

1. In Supabase: **SQL Editor → New query**.
2. Open `schema.sql` from this repo, paste the whole thing in, and click **Run**.
   This creates the tables, security rules, realtime, the private file bucket, and a few sample leads.

## Step 3 — Create the 4 caller accounts

1. Supabase → **Authentication → Users → Add user** (or **Invite**).
2. Add an email + password for each of the 4 callers.
   - To set nice display names, click a user → **User Metadata** and add `full_name` (e.g. `Jake`). A profile row is created automatically; you can also edit `profiles` directly in **Table Editor** to set each person's `initials` and avatar `color`.
3. (Optional) Authentication → **Providers → Email**: turn **Confirm email** off for the fastest start, or leave on and confirm the invite emails.

## Step 4 — Point the app at your project

1. Supabase → **Project Settings → API**. Copy:
   - **Project URL**
   - **anon / public** key
2. Open `config.js` and paste them in:
   ```js
   export const SUPABASE_URL = "https://xxxx.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...";
   ```
   > The anon key is meant to be public — it only works within the row-level-security rules in `schema.sql`. Safe to commit.

## Step 5 — Put it on GitHub

```bash
cd noapro-caller
git init
git add .
git commit -m "NoaPro Caller v1"
git branch -M main
git remote add origin https://github.com/<you>/noapro-caller.git
git push -u origin main
```

## Step 6 — Deploy (pick one)

**Vercel (recommended):**
- vercel.com → **Add New → Project** → import your GitHub repo → **Deploy**.
- No build settings needed (it's a static site). You get a live URL in ~30s.
- Add your domain under **Settings → Domains**, e.g. `caller.noapro.co.uk`.

**GitHub Pages (alternative):**
- Repo → **Settings → Pages** → Source: `main` / root → **Save**. Live at `https://<you>.github.io/noapro-caller/`.

## Step 7 — Allow your site to talk to Supabase

- Supabase → **Authentication → URL Configuration** → add your deployed URL (e.g. `https://caller.noapro.co.uk`) to **Site URL / Redirect URLs**.

Done. Open the URL, sign in, and the queue loads.

---

## Day-to-day use

- **Call Queue** — click **Claim** on a lead; it locks for everyone instantly. Make the call, type notes, hit an outcome. "Callback" reveals a date/time picker; the lead resurfaces in the queue when due. **Release** puts it back if you grabbed it by mistake.
- **Import CSV** — top bar. Needs at least a `business` column; it also recognises `phone`, `category`, and `area` (any order, case-insensitive). See `sample-leads.csv`.
- **Add lead** — manual one-off entry.
- **Export results** — top bar; downloads every lead with its current status, last-called time, callback, and notes as a CSV.
- **Export call log** — top bar; downloads every individual dial (timestamp, caller, business, phone, area, outcome, note) for deeper reporting.
- **Dashboard** — live team stats and leaderboard, plus **targets** with a **Day / Week / Month** toggle: per-caller progress bars for calls and sign-ups (bar turns green when the target is hit). Set the daily targets in `config.js` (`DAILY_CALL_TARGET`, `DAILY_SIGNUP_TARGET`); Week and Month scale them by `WORKING_DAYS_PER_WEEK` / `WORKING_DAYS_PER_MONTH`.
- **Files** — upload scripts, lead lists, info docs (private; downloads use short-lived signed links).

## Signing in

Two ways, both built in:
- **Password** — the email + password you set in Supabase.
- **Magic link** — type your email and click *"Email me a magic link instead"*; Supabase emails a one-click sign-in link (no password to remember). For this, make sure your deployed URL is listed under Supabase → **Authentication → URL Configuration**.

## Customising the look

All brand colours and the font are CSS variables at the top of `styles.css` (`:root`). Replace them with your exact NoaPro hex/font and the whole app re-skins. Swap the `N` logo block in `index.html` / `styles.css` for your logo if you like.

## Compliance reminder

UK cold-calling is governed by **PECR/TPS**. Screen your lists against the **Telephone Preference Service** before importing, and use the **Do not call** outcome for any opt-outs — those leads are then permanently hidden from the queue.

## Notes / limits

- "Free tier" means Vercel/Supabase host it; both are open-source/exportable, so you can self-host later with the same code if you ever want to.
- Auth supports both email + password and magic-link out of the box.
- This is a v1 focused on the calling loop. Easy next additions: per-area lead filters, round-robin auto-assignment, and scheduled email of the daily call-log export.
