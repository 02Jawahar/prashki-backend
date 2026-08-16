# Deploying to Dokploy

Three pieces: a **PostgreSQL** database, the **backend** (Express API), and the
**frontend** (Next.js). Dokploy runs each as its own application and puts Traefik
in front for domains and TLS.

Total time: about 30 minutes, most of it waiting on builds.

---

## Before you start

**Two repositories**, deployed as two Dokploy applications:

| | |
|---|---|
| API | `github.com/02Jawahar/prashki-backend` *(this one)* |
| Storefront | `github.com/02Jawahar/prashki-frontend` |

Confirm `.env` files are **not** committed — `.gitignore` excludes them, but
check, because they contain your JWT secrets.

**Decide your domains.** Two subdomains of *one* registrable domain:

```
shop.example.com   ->  frontend
api.example.com    ->  backend
```

> **This matters more than it looks.** Sessions are httpOnly cookies set by the
> API. Subdomains of the same domain count as the *same site*, so the cookie
> travels from `shop.` to `api.` normally. Put them on two unrelated domains and
> the browser treats the session cookie as third-party — logins will appear to
> succeed and then immediately fail. If you truly cannot share a domain, see
> [Different domains](#if-the-two-are-on-different-domains).

**Generate secrets.** Run twice, keep both:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 1. PostgreSQL

In Dokploy: **Project → Create Service → Database → PostgreSQL**.

| Field | Value |
|---|---|
| Name | `ecommerce-db` |
| Docker image | `postgres:18-alpine` |
| Database | `ecommerce` |
| User | `ecommerce` |
| Password | *(generate a strong one)* |

Deploy it, then copy the **internal connection string**. It looks like:

```
postgresql://ecommerce:PASSWORD@ecommerce-db:5432/ecommerce
```

Use the **internal** host, not a public one — the API talks to it over Dokploy's
Docker network. Do not expose the database publicly.

Append the schema parameter when you use it:

```
postgresql://ecommerce:PASSWORD@ecommerce-db:5432/ecommerce?schema=public
```

---

## 2. Backend

**Project → Create Service → Application**, source = `prashki-backend`, branch
`main`.

### Build

| Field | Value |
|---|---|
| Build Type | **Dockerfile** |
| Dockerfile Path | `Dockerfile` |
| Build Context / Path | `.` |

### Environment

```bash
NODE_ENV=production
PORT=4000

DATABASE_URL=postgresql://ecommerce:PASSWORD@ecommerce-db:5432/ecommerce?schema=public

JWT_ACCESS_SECRET=<first generated secret>
JWT_REFRESH_SECRET=<second generated secret>
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30

FRONTEND_URL=https://shop.example.com
COOKIE_DOMAIN=.example.com
COOKIE_SAMESITE=lax

# Seed credentials — used only if you run the seed. Change them.
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<a real password>
CUSTOMER_EMAIL=customer@example.com
CUSTOMER_PASSWORD=<a real password>

PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=rzp_live_xxx
RAZORPAY_KEY_SECRET=xxx
RAZORPAY_WEBHOOK_SECRET=xxx

EMAIL_PROVIDER=console
EMAIL_FROM=orders@example.com

STORAGE_PROVIDER=local
STORAGE_LOCAL_DIR=uploads
STORAGE_PUBLIC_URL=https://api.example.com/uploads
```

Notes on three of these:

- **`FRONTEND_URL`** is the CORS allow-list. It is never `*`, because sessions
  are cookies. Get it wrong and every browser request fails CORS.
- **`COOKIE_DOMAIN`** with the leading dot lets one session cookie cover both
  subdomains.
- **`STORAGE_PUBLIC_URL`** is baked into image URLs as they are saved. Set it
  correctly *before* uploading anything, or those rows point at the wrong host.

### Domain

Add domain `api.example.com`, container port **4000**, HTTPS on, Let's Encrypt on.

### Volume

**Mount path** `/app/uploads`, as a persistent volume.

Skip this and every product image and hero video is deleted on the next deploy.
(Or set `STORAGE_PROVIDER=s3` once that provider is implemented, and skip the
volume.)

Deploy. Migrations run automatically at container start — the entrypoint is
`prisma migrate deploy && node dist/server.js`.

Check it:

```
https://api.example.com/health
→ {"success":true,"data":{"status":"ok","database":"up","env":"production"}}
```

---

## 3. Frontend

**Project → Create Service → Application**, source = `prashki-frontend`, branch
`main`.

### Build

| Field | Value |
|---|---|
| Build Type | **Dockerfile** |
| Dockerfile Path | `Dockerfile` |
| Build Context / Path | `.` |

### Build arguments — not environment variables

> **The single most common way to get this wrong.** `NEXT_PUBLIC_*` values are
> compiled into the browser bundle at **build** time. Setting them as runtime
> environment variables does nothing to the client-side code — the app will build
> fine and then call `localhost:4000` from your visitors' browsers.
>
> Put these in Dokploy's **Build Args**, and rebuild whenever they change.

```bash
NEXT_PUBLIC_API_URL=https://api.example.com/api/v1
NEXT_PUBLIC_SITE_URL=https://shop.example.com
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_live_xxx
API_URL=http://<backend-service-name>:4000/api/v1
```

`API_URL` is what server-side rendering uses. Pointing it at the **internal**
service name keeps that traffic off the public internet and off Traefik. Using
the public URL also works, just slower.

### Environment

```bash
NODE_ENV=production
PORT=3000
API_URL=http://<backend-service-name>:4000/api/v1
```

### Domain

Add domain `shop.example.com`, container port **3000**, HTTPS on, Let's Encrypt on.

Deploy.

---

## 4. Bootstrap the first admin

The database is empty after the first deploy — migrations create the tables but
add no rows, so there is no admin account and nothing to sign in with.

Open a terminal on the **backend** container in Dokploy and run:

```bash
cd /app && npm run db:bootstrap
```

That creates the permission catalogue, the six default roles, the default
settings, and — only if there are no users at all — one Super Admin from
`ADMIN_EMAIL` / `ADMIN_PASSWORD`. It deletes nothing, and running it twice is
harmless. Run it after **every** deploy that adds a new permission, so the new
key exists before the route that checks for it is reachable.

Sign in at `https://shop.example.com/admin` with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
**Change the password immediately** — it was in an environment variable.

> **Never run `prisma/seed.ts` against production.** It builds the demo shop,
> and it starts by deleting every table — orders included. In production it
> refuses to run at all unless `ALLOW_DESTRUCTIVE_SEED=yes-delete-everything` is
> set, which is a value you should not have a reason to type.

---

## 5. Razorpay webhook

In the Razorpay dashboard → **Settings → Webhooks → Add New Webhook**:

| Field | Value |
|---|---|
| URL | `https://api.example.com/api/v1/webhooks/razorpay` |
| Secret | the same value as `RAZORPAY_WEBHOOK_SECRET` |
| Events | `payment.captured`, `payment.failed`, `order.paid` |

The signature is computed over the **raw request body**, so nothing may sit in
front that rewrites it. Traefik does not, which is why this works as-is.

Test with Razorpay's "Send Test Webhook". A correct delivery returns `200` and
records a row in `webhook_events`; a redelivery of the same event returns `200`
with `duplicate: true` and changes nothing.

---

## Deploy order, and why

1. **Database** — the backend will not start without it (it refuses to serve
   traffic it cannot fulfil, rather than returning 500s).
2. **Backend** — the frontend build reads settings for navigation. It survives
   the API being down, but you get the fallback nav.
3. **Frontend** — needs `NEXT_PUBLIC_API_URL` final at build time.

Redeploy the frontend whenever a `NEXT_PUBLIC_*` value changes. Backend
environment changes only need a restart.

---

## Verifying

```bash
curl https://api.example.com/health
curl https://api.example.com/api/v1/products
```

Then in a browser:

1. `https://shop.example.com` loads with products
2. Add to bag **without signing in**, then go to checkout → redirected to login
3. Register, and the bag follows you
4. Place an order, pay through Razorpay
5. `https://shop.example.com/admin` → the order is there
6. `/admin/inventory` → stock reduced by what was bought

If login appears to work but you are signed out on the next page, it is the
cookie. Check `COOKIE_DOMAIN` and that both hosts share a registrable domain.

---

## If the two are on different domains

Only if you cannot share a domain:

```bash
COOKIE_SAMESITE=none
COOKIE_DOMAIN=          # leave empty
```

`SameSite=none` forces `Secure`, so both sides must be HTTPS. Be aware that
browsers are progressively restricting third-party cookies, so this arrangement
is fragile. Sharing a domain is materially better.

---

## Rolling back

Read this before the first production deploy, not during the incident.

### The rule that makes rollback possible

**Code rolls back. Migrations do not.** Reverting a schema change on a live
database means dropping columns that hold real rows, and a `DROP COLUMN` is not
recoverable from anything except a backup.

So every migration must be written to work with the *previous* version of the
code as well as the new one:

- Adding a nullable column, a table, or an index — safe. Old code ignores it.
- Adding a `NOT NULL` column with a default — safe. Old code ignores it.
- Renaming or dropping a column, narrowing a type, adding a constraint the old
  code would violate — **not safe**. Split it across two deploys: deploy the
  code that stops using the column, then, once that is known good, drop it.

Follow that and rolling back is redeploying the previous image, with the
database left alone.

### Rolling back the application

In Dokploy, **Deployments** → pick the previous successful deployment →
**Redeploy**. Do the frontend and the backend separately; they are independent
services and usually only one is at fault.

Roughly a minute. Nothing is lost, because nothing is being undone in the
database.

If the previous image is gone, redeploy from the previous commit:

```bash
git revert <bad-commit>    # not reset — the branch is shared
git push
```

### If the bad deploy included a migration

1. **Stop writes first.** Scale the backend to zero replicas in Dokploy. Every
   second it stays up is more rows written in a shape you are about to change.
2. Decide which case you are in:
   - **The migration is additive** (the usual case, and what the rule above
     exists to guarantee): leave it. Roll the code back and the extra column
     sits there unused. Clean it up in a later deploy.
   - **The migration is destructive and you need what it removed**: restore
     from backup. That is the only route. See below.
3. Bring the backend back up.

Never hand-edit `_prisma_migrations` to make a migration "un-run". The table
records what was applied; changing it desynchronises Prisma's view from the
actual schema, and the next deploy fails in a much more confusing way.

### Restoring from a backup

This loses every order placed since the backup was taken, so it is the last
option, not the first.

```bash
# On the database container
pg_restore --clean --if-exists -U ecommerce -d ecommerce /path/to/backup.dump
```

Then redeploy the backend at the commit that matches that backup's schema — a
newer image against an older schema fails on the first query.

**Confirm before you need it:** Dokploy's PostgreSQL backups are not on by
default. Turn them on, then restore one into a scratch database once and check
the order count. An untested backup is not a backup.

### A migration that failed part-way

`P3009: migrate found failed migrations` on boot. The migration ran, hit an
error, and Prisma will not proceed past it.

```bash
# What actually happened
psql -U ecommerce -d ecommerce -c \
  "select migration_name, finished_at, logs from _prisma_migrations \
   where finished_at is null order by started_at desc limit 5;"
```

Fix the cause — usually existing rows that violate a new constraint — then:

```bash
npx prisma migrate resolve --rolled-back <migration_name>
```

and redeploy. That marks it as not applied so it runs again cleanly. Use
`--applied` only if you have verified by inspecting the schema that the change
did in fact land.

### Rolling back settings and content

Store settings, pages and navigation are rows, not code, so a redeploy does not
touch them. A bad settings change is undone in the admin UI, and
`/admin/audit` records who changed what and when.

### After any rollback

```bash
curl https://api.example.com/health
curl https://api.example.com/api/v1/products
```

Then check `/admin/webhook-events` for callbacks that failed while the service
was down. Razorpay retries for a while, but not forever; anything left as
`FAILED` or `RECEIVED` can be replayed from that page. An order paid at the
gateway but unpaid in the store is the failure mode a rollback most often
leaves behind.

---

## Production hardening

Worth doing before real traffic:

- **Object storage.** `STORAGE_PROVIDER=local` with a volume works, but it ties
  uploads to one host. `S3StorageProvider` is a stub — implementing that one
  interface is the only change needed.
- **Email.** `EMAIL_PROVIDER=console` logs order confirmations instead of sending
  them. Implement `EmailProvider` for Resend/SendGrid/SES.
- **Backups.** Dokploy can schedule PostgreSQL backups. Turn them on.
- **Rate limits** currently key on IP. Behind Traefik, `trust proxy` is already
  set to 1 so the real client IP is used — verify that if you add another proxy
  layer in front.
- **`ADMIN_PASSWORD`** stays in the environment after seeding. Change the
  password in the app, then clear the variable.

---

## Troubleshooting

**Build fails: `Cannot find module` or a missing lockfile**
Build Path should be `.` and Dockerfile Path just `Dockerfile` — each repository
is standalone, with its own lockfile at its root.

**Frontend builds, but the browser calls `localhost:4000`**
`NEXT_PUBLIC_API_URL` was set as an environment variable instead of a **build
arg**. Move it and rebuild.

**Every browser request fails CORS**
`FRONTEND_URL` on the backend does not exactly match the storefront origin —
scheme included, no trailing slash.

**Login succeeds, next request is anonymous**
Cookie scope. Both hosts must share a registrable domain with
`COOKIE_DOMAIN=.example.com`, or use `COOKIE_SAMESITE=none` over HTTPS.

**Images 404 after a redeploy**
No volume on `/app/uploads`, so uploads were inside the container layer.

**Images point at the wrong host**
`STORAGE_PUBLIC_URL` was wrong when they were uploaded. The absolute URL is
stored per row; fix the variable and re-upload, or update the rows.

**`P3009: migrate found failed migrations`**
A migration failed part-way. Inspect `_prisma_migrations`, fix the cause, then
`prisma migrate resolve --rolled-back <name>` before redeploying.

**Backend exits immediately with "Database unreachable"**
Deliberate — it refuses to serve traffic without a database. Check `DATABASE_URL`
uses the internal service hostname and that the database service is healthy.
