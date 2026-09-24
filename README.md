# FBMS — Food & Beverage POS

A point-of-sale system for quick-service chains (counter, drive-thru, self-order kiosk) and full-service restaurants (tables, open tabs, rounds). It is built for Philippine operations: VAT-inclusive pricing, Senior Citizen / PWD discounts, official-receipt numbering, and X/Z readings.

It runs on Node.js 22. An in-store server uses Node's built-in SQLite, so a single `npm start` runs it on any till PC, mini-PC or container. It also runs on **Vercel** with a hosted Turso database (see below).

| Screen | URL | Who |
|---|---|---|
| Sign-in / launcher (tap name + PIN) | `/` | everyone |
| **POS terminal** | `/pos` | cashier, manager, admin |
| **Kitchen display (KDS)** | `/kds` | kitchen + all |
| **Now Serving board** | `/queue` | public (TV screen) |
| **Self-order kiosk** | `/kiosk` | public (customer tablet) |
| **Back office** | `/admin` | manager, admin |

## Quick start

```bash
cp .env.example .env      # optional
npm start                 # http://localhost:8080
npm test                  # unit + API tests, on both database backends
```

On first boot an empty database is seeded with a demo menu, recipes and stock, 16 tables and about two weeks of sales history, so the dashboard has data to show.

| Role | Username | Password | PIN |
|---|---|---|---|
| Admin | `admin` | `Admin@12345` | 9999 |
| Manager | `maria` | `Manager@123` | 2222 |
| Cashier | `juan` / `ana` | `Cashier@123` | 1111 / 3333 |
| Kitchen | `pedro` | `Kitchen@123` | 4444 |

> **Change every demo password and PIN before going live**, or start with `SEED_DEMO=false` on a fresh database. The sign-in page then shows a **Set up your store** form where you create the owner (admin) account. The owner adds everyone else in **Back office → Staff**; there is no public sign-up, by design.

`npm run seed` wipes the database and reseeds it. It asks you to type `RESET` first.

Docker:

```bash
docker build -t fbms-pos .
docker run -p 8080:8080 -v fbms-data:/data fbms-pos
```

## Features

**Ordering**
- Menu with categories, value meals and upsizes. Modifier groups have min/max rules: pick a drink, pick a side, add-ons, chicken part, flavor.
- Dine-in, take-out, drive-thru and delivery. Customer name for call-out, guest count, kitchen notes on each line.
- Hold and recall orders. Floor plan shows which tables are occupied. Open tabs can be sent to the kitchen in rounds.
- 86 / sold-out control from the till. An item also goes out of stock automatically when its ingredients run out.
- Prices are **always calculated on the server** from the catalogue; prices sent by a client are ignored.

**Payments & compliance**
- Cash with change due and quick-cash buttons. Card, GCash and Maya (reference number required for e-wallets). Split tender.
- Sequential **OR numbers**. Receipt shows the VATable / VAT / VAT-exempt / zero-rated breakdown. Formatted for 80 mm thermal printers.
- **SC/PWD discount** (RA 9994 / RA 10754): the qualifying share of the bill is made VAT-exempt, then 20% is taken off. ID numbers are required and printed on the receipt.
- Promo, employee and fixed-amount discounts. These need **manager PIN approval** and never stack with SC/PWD on the same peso.
- Configurable service charge (optionally dine-in only).

**Controls**
- Cashier shifts: opening float, pay-in / payout / safe drop, **blind close** with over/short, X-reading.
- **Z-reading** once per business day, with beginning/ending OR and an accumulated grand total. It is blocked while orders or shifts are still open.
- Void (open orders) and refund (paid orders) need manager approval. A refund can put ingredients back into stock.
- Removing an item already sent to the kitchen needs manager approval and is logged as waste.
- Append-only **audit log** for approvals, voids, refunds, discounts, 86s, menu and price changes, users and settings.
- Roles: admin, manager, cashier, kitchen. Server-side sessions can be revoked. Login and PIN attempts are rate-limited.

**Kitchen & customer displays**
- Live KDS over Server-Sent Events. Station filter (grill, fryer, assembly, drinks, dessert). Ticket timers turn amber, then red. Start → Ready → Picked up, with recall. Strike-through per line. Optional sound.
- Now Serving board with a chime when an order is ready. It shows order numbers only.
- Self-order kiosk: a customer's order lands in the POS as an open "Kiosk" order to pay at the counter. The kiosk resets after 90 seconds idle.

**Back office**
- Dashboard: net sales, transactions, average ticket, discounts, refunds, kitchen speed; sales by hour or day; payment mix; channels; top sellers; categories; low stock.
- Menu editor with modifier groups and a recipe (bill of materials) that shows live food-cost %.
- Inventory: receive, waste and physical count, full movement history, reorder levels, stock value.
- Staff, tables, store/tax/receipt settings, order search with receipt reprint.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design decision record.

```
api/index.js          Vercel serverless entry (same handler as the server)
server/
  index.js            process entry for a long-running server (boot, seed, graceful shutdown)
  app.js              composition root: DB → services → HTTP
  config.js           env-driven configuration
  db/                 async DB layer (node:sqlite locally, libSQL/Turso remote), migrations/, seed
  http/               router, static files, SSE event bus, rate limiter
  auth/               scrypt hashing, RBAC capability map
  services/           business logic (orders, pricing, shifts, inventory, reports, …)
  routes/api.js       REST endpoints + input validation
public/               browser clients (vanilla ES modules, no build step)
tests/                node:test unit + API integration tests
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `DB_PATH` | `./data/fbms.db` | Local SQLite file (WAL mode) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | — | Hosted libSQL/Turso database; used instead of `DB_PATH` (required on Vercel) |
| `SEED_HISTORY` | `true` locally, `false` on Vercel | Also seed two weeks of demo sales |
| `SESSION_TTL_HOURS` | `12` | Staff session lifetime |
| `SEED_DEMO` | `true` | Seed demo data into an empty DB |
| `TZ_BUSINESS` | `Asia/Manila` | Business-date / hourly-report timezone |

Store name, TIN, permit number, VAT, service charge and KDS thresholds are set in **Back office → Settings**.

## Deploy to Vercel

Vercel serves the pages from `public/` and runs the API as a serverless function (`api/index.js`). Serverless functions have no disk that persists, so the data lives in a hosted **Turso** database. Turso is SQLite-compatible and has a free tier.

1. **Create the database.** Sign up at [turso.tech](https://turso.tech), create a database, then copy its **URL** (`libsql://…turso.io`) and create an **auth token**.
   (Alternatively, add Turso from the **Vercel Marketplace**, which fills in the variables for you.)
2. **Add environment variables** in Vercel → your project → **Settings → Environment Variables**:
   - `TURSO_DATABASE_URL` = the `libsql://…` URL
   - `TURSO_AUTH_TOKEN` = the token
   - optional `SEED_DEMO=false` to start empty and create your own owner account instead of the demo logins
   - optional `SEED_HISTORY=true` to also load two weeks of demo sales for the dashboard
3. **Redeploy** (Deployments → ⋯ → Redeploy). The first request creates the tables and, unless you turned it off, loads the demo menu and staff.

`vercel.json` already sets the build step, the clean URLs (`/pos`, `/kds`, …) and the API route. On Vercel, live updates (kitchen display, Now Serving board, kiosk alerts on the POS) arrive by polling every few seconds instead of a live stream. An in-store server pushes them instantly.

> For a busy store, an **in-store server** (a mini-PC running `npm start`) is still the most robust setup: it keeps selling when the internet is down. Use Vercel for a cloud or demo deployment, or for a single low-volume outlet.

## Production notes

- Run behind HTTPS (a reverse proxy such as Caddy or nginx). Tills should reach the server over the LAN.
- Back up `DB_PATH` regularly. With WAL mode, use `sqlite3 fbms.db ".backup backup.db"` rather than copying the file while it is live.
- Rate limiting is in-memory and assumes a single server node, which is how a store-level POS usually runs.
- The receipt layout follows common BIR practice, but get your specific CAS/PTU accreditation requirements checked by your accountant.
