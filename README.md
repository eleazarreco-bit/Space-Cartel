# Car Keys — shared server

Everyone's daily BAN/CTN assignment, call status, callbacks, and PINs now live in
one shared Postgres database via a small Node/Express API. Any number of agents,
on any device with a browser, can log in to the same hosted URL and see
consistent, shared state — including the "same 20 BANs on re-login" lock, and
another agent's Called/Completed status showing up on your screen too.

This replaces the earlier single-browser (localStorage) version.

## What's in this folder

```
server.js          — the API + static file server (run this)
schema.sql          — run once against your Postgres database to create tables
package.json
data/
  car_keys_data.json — the read-only dataset (regenerate if the source Excel changes)
public/
  index.html         — the app UI
  app.js             — thin client, talks to the API only
.env.example
```

## 1. Get a free Postgres database

Any standard Postgres works. Two free options that need no credit card:

- **Supabase** (supabase.com) → New Project → Settings → Database → copy the
  "Connection string" (URI format, the "Transaction pooler" one works well).
- **Neon** (neon.tech) → New Project → copy the connection string it gives you.

Either way you'll end up with something like:
`postgres://USER:PASSWORD@HOST:PORT/DBNAME`

## 2. Create the tables

With `psql` installed locally, or the SQL editor in Supabase/Neon's web UI, run
the contents of `schema.sql` once against your new database.

## 3. Configure and run locally (to test before hosting)

```bash
cp .env.example .env
# edit .env: paste your DATABASE_URL, leave PORT as 3000
npm install
npm start
```

Open `http://localhost:3000` — log in and confirm you can pull BANs, mark one
Called/Completed, etc. Then open the same URL in a second browser (or an
incognito window) and log in to the *same store* — you should see the same 20
BANs, and any status changes from one window show up in the other within ~20
seconds (or immediately after any action you take, since the page always
re-fetches the card list after saving).

## 4. Deploy it so others can reach it over the internet

Any Node host works. Render.com is a straightforward option with a free tier:

1. Push this folder to a GitHub repo.
2. Render.com → New → Web Service → connect the repo.
3. Build command: `npm install`   ·   Start command: `npm start`
4. Add an environment variable `DATABASE_URL` with your connection string from
   step 1 (and `PGSSL` — leave unset/true if your provider requires SSL, which
   Supabase and Neon do by default over the internet).
5. Deploy. Render gives you a public URL (`https://your-app.onrender.com`) —
   share that with your agents.

Railway, Fly.io, and a plain VPS (`node server.js` behind Nginx + a process
manager like PM2) all work the same way — the app itself holds no state, so it
can be redeployed or restarted freely without losing data (everything's in
Postgres).

**Note:** the `data/car_keys_data.json` file (~40MB) needs to actually be
present on whatever host you deploy to — make sure it's committed to the repo
(or uploaded separately) and not excluded by a `.gitignore`.

## 5. Keep it up to date

If the source `CAR-Data...xlsx` file gets a new export, regenerate
`data/car_keys_data.json`:

```bash
cd data
python3 build_data.py /path/to/New-CAR-Data-Export.xlsx
```

(needs `pip install openpyxl` if you don't already have it) then restart the
server (or redeploy). The database (assignments, statuses, callbacks, PINs) is
untouched by this — only the read-only reference data changes.

## Notes on scope and security

- Store PINs (set from the Admin screen) are a light deterrent, not real
  authentication — anyone with the store's PIN can log in as that store. Don't
  rely on this alone if the tool needs to be genuinely access-controlled;
  ask me to add real user accounts if that matters for your rollout.
- There's no HTTPS handled by the app itself — Render/Railway/Fly all provide
  HTTPS automatically on their default domains. If you self-host on a VPS,
  put it behind a reverse proxy (Caddy or Nginx + Let's Encrypt) so PINs and
  agent names aren't sent in plaintext.
- The admin screen's "Erase all local data" button is intentionally disabled
  in this version, since the data is shared and shouldn't be wiped from the
  browser. To clear data on purpose, run SQL `DELETE FROM ...` on the specific
  tables in `schema.sql`.
