# Prash & Ki — API

Commerce API for Prash & Ki: catalogue, cart, orders, payments and the admin
surface.

```
Express 5 · TypeScript · Prisma 6 · PostgreSQL 18
```

Storefront lives in **[prashki-frontend](https://github.com/02Jawahar/prashki-frontend)**.

---

## Quick start

```bash
npm install
cp .env.example .env      # then edit it
npm run setup             # create the database, apply the schema, seed demo data
npm run dev               # http://localhost:4100/api/v1
```

No PostgreSQL install or Docker needed for development — see
[The database](#the-database).

Seed credentials come from `.env` (`ADMIN_EMAIL` / `ADMIN_PASSWORD`,
`CUSTOMER_EMAIL` / `CUSTOMER_PASSWORD`).

---

## Conventions

**Money is integer paise.** `₹15,000.00` is stored as `1500000`. No floats touch
a total. Discounts are always *derived* from `price` and `compareAtPrice`, never
stored, so they cannot drift.

**Snapshots.** Order lines copy product name, SKU, image and price at purchase
time; orders copy the shipping address. Reconstructing an old order never
depends on the current catalogue.

**Inventory is a ledger.** Stock lives in `inventory`, and every change writes an
`inventory_movements` row in the same transaction, recording the balance after.
Nothing writes `availableStock` directly.

**The server is the source of truth** for price, stock, discount, totals, payment
status and permissions. Clients send only *which* variant and *how many*.

---

## Layout

```
src/
├── config/         env (Zod-validated) · db · logger · embedded-db
├── middleware/     auth · validate · error · rate-limit · upload
├── modules/        auth · products · categories · inventory · cart
│                   addresses · orders · payments · webhooks · media · admin
├── integrations/   storage · payment · notifications
├── events/         in-process event bus + handlers
├── utils/          errors · response · money · tokens · audit
├── app.ts          Express app
└── server.ts       bootstrap
prisma/             schema · migrations · seed
scripts/            db lifecycle + smoke tests
```

---

## Authentication and authorization

One `users` table for customers and staff, separated by `role` plus granular
role→permission grants. There is no second auth system.

- Access token (15 min JWT) + refresh token (30 days, opaque), both **httpOnly**
- Refresh tokens stored **hashed** and **rotated**; replaying a rotated token
  revokes the whole token family
- Passwords hashed with **Argon2id**
- Every admin endpoint checks, in order: authenticated → account active → role →
  permission

Seeded roles: `SUPER_ADMIN`, `CATALOG_MANAGER`, `ORDER_MANAGER`, `SUPPORT` over
20 permissions.

> Cookie scope matters in production. The storefront and this API should share a
> registrable domain (`shop.example.com` + `api.example.com`) with
> `COOKIE_DOMAIN=.example.com`. See `DEPLOYMENT.md`.

---

## Payments

Provider-independent. `PaymentProvider` is the only thing order logic sees.

```
PaymentProvider
├── RazorpayProvider     server-side order creation, HMAC verification, signed webhooks
└── MockPaymentProvider  development; signs and verifies with the same HMAC shape
```

1. The order is created first as `PENDING_PAYMENT`, so any payment can be matched
   back to it
2. The gateway order is created **server-side** with our amount — the browser
   cannot ask to pay less
3. The client callback is believed only after its **signature verifies here**
4. The **webhook** is authoritative: verified against the **raw body bytes**,
   recorded by provider event id with a unique constraint, acknowledged with 200
   immediately, processed after

An order is marked `PAID` in exactly one place and that path is idempotent, so a
redelivered webhook produces no second transition. A webhook whose amount
disagrees with the order is refused.

The app refuses to start in production with the mock provider selected.

---

## The database

For development the API embeds a real PostgreSQL 18 from `node_modules` into
`.pgdata-dev/`. Prisma cannot tell the difference. Point `DATABASE_URL` at any
other PostgreSQL and the embedded server is bypassed.

Two behaviours worth knowing:

- **Port discovery.** The bootstrap probes upward from `PG_PORT` and, for any
  port already in use, *connects* to check whether that server is ours before
  reusing or skipping it. A port that answers is not assumed to be the right
  database.
- **The database is left running** between API restarts. `npm run db:stop` is the
  supported way to stop it — a postmaster that is killed rather than shut down
  leaves its socket bound and its shared-memory block held, which blocks the
  next start.

Production uses `prisma migrate deploy` against the committed migration.

---

## Commands

```bash
npm run dev              # API with watch
npm run build            # prisma generate + tsc
npm run start            # run the built output
npm run typecheck

npm run setup            # db:push + db:seed
npm run db:migrate       # create a migration
npm run db:deploy        # apply committed migrations (production)
npm run db:seed          # rebuild demo data — destructive
npm run db:studio        # Prisma Studio
npm run db:reset         # delete the cluster and rebuild
npm run db:stop          # shut the local database down cleanly
npm run db:ping          # show which database resolves

npm run test:smoke       # seven suites against the live API
npm run test:acceptance  # full end-to-end business flow
```

---

## Verification

The suites exercise the real HTTP surface against the real database, and are
written to attack the API rather than flatter it:

- an unknown email and a wrong password return an identical error
- replaying a rotated refresh token revokes the family
- a logged-in customer gets 403 on admin routes
- prices injected into a cart request are ignored
- stock cannot go negative, and cancelling an order returns it
- a forged payment signature never marks an order paid
- a redelivered webhook is a no-op

Run them with the API up:

```bash
npm run test:smoke
npm run test:acceptance
```

---

## API surface

Everything under `/api/v1`.

```
POST   /auth/register  /auth/login  /auth/logout  /auth/refresh
GET    /auth/me

GET    /products  /products/:slug
GET    /categories  /categories/:slug
GET    /settings

GET    /cart          POST /cart/items
PATCH  /cart/items/:id   DELETE /cart/items/:id

GET    /addresses     POST /addresses   PATCH|DELETE /addresses/:id
POST   /orders        GET  /orders      GET /orders/:id
POST   /payments/create   POST /payments/verify
POST   /webhooks/razorpay

GET    /admin/stats  /admin/products  /admin/orders  /admin/customers
POST   /admin/products    PATCH /admin/products/:id
POST   /admin/media       PATCH /admin/settings
```

Responses are always `{ success: true, data }` or
`{ success: false, error: { code, message } }`.

---

## Deployment

See **`DEPLOYMENT.md`** for the full Dokploy walkthrough, or use
`docker-compose.yml` for any Docker host.

Not built yet, with the architecture prepared for each: coupons, returns and
refunds, real email templates, SMS/WhatsApp delivery, Redis/BullMQ, and an S3/R2
storage provider.
