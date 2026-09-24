# Design decision record — FBMS POS

## Scope
A store-level POS for quick-service (McDo/Jollibee-style counter, drive-thru, kiosk) and full-service restaurants. It covers ordering, payments, kitchen routing, cash control, inventory depletion, reporting and audit. Out of scope for v1: multi-branch head-office sync, loyalty programs, delivery-aggregator integrations, and direct card-terminal or ESC/POS printer drivers (receipts print through the browser).

## Panel review summary

| Concern | Position taken | Trade-off accepted |
|---|---|---|
| **Architecture** | A modular monolith: one Node process, with services split by domain (`orders`, `pricing`, `shifts`, `inventory`, `reports`). | Microservices were rejected. A single store runs one server, and a small team cannot operate a service mesh. The domain boundaries leave a path to split services out later. |
| **Dependencies / supply chain** | Two runtime packages, `pg` and `@libsql/client`, each loaded only when that hosted database is configured. Otherwise it uses Node's built-in `http` and `node:sqlite`, with vanilla ES modules and no front-end framework. | Some routing and validation code is hand-written. `node:sqlite` is still flagged experimental, so it is pinned to Node ≥ 22.13. |
| **Hosting** | Two deployment shapes share one request handler: a long-running server (in-store, Docker) and a Vercel serverless function (`api/index.js`). The DB layer is async with three backends: local `node:sqlite` (one connection, operations serialised by an async lock so awaits inside a transaction never interleave with other requests), remote libSQL/Turso (interactive write transactions) and PostgreSQL/Neon (pooled connections; `?` placeholders rewritten to `$n`, `RETURNING id` added to INSERTs, its own migration folder). Services stick to SQL that runs on both dialects. AsyncLocalStorage routes calls inside `transaction()` to the open transaction. | Serverless can't hold SSE streams across instances, so there clients poll `/api/public/changes` (~4 s). The demo seed is written as batched inserts with explicit ids so first boot is a few round trips. |
| **Data** | SQLite (local, WAL mode), libSQL/Turso or PostgreSQL/Neon (hosted), forward-only numbered SQL migrations, money stored as integer cents, every stock change recorded in `stock_movements`. | Postgres was not chosen because a till must keep selling when the WAN is down. A store-local DB avoids that. |
| **Correctness of money** | `services/pricing.js` is pure, has property-style tests that check the components reconcile to the total, and is **served to the browser as-is**, so on-screen and server totals cannot drift. | Client code depends on a server-served module. |
| **Security** | Server-side sessions store only a SHA-256 of the token. scrypt hashes for passwords and PINs. An RBAC capability map. Manager overrides by PIN are rate-limited. Strict CSP with no inline scripts. All HTML is escaped via `h()`. Path-traversal-safe static serving. Input is validated at the route boundary. | Tokens are kept in `localStorage` so a till stays signed in. This is acceptable because of the strict CSP and escaping; revocation happens on the server. |
| **Auditability** | Voids, refunds, discounts, line removals after sending, 86s, price changes, user and settings changes all go to `audit_log` with the approver's identity. | The log is append-only. There is no UI to purge it. |
| **Real-time** | Server-Sent Events carry a minimal payload (id, number, statuses). Clients re-fetch details over authenticated endpoints. | SSE was chosen over WebSockets because it is simpler, works through proxies and reconnects automatically. The public stream exposes order numbers only. |
| **Operations** | Structured JSON request logs, `/api/health`, graceful shutdown, Dockerfile with a healthcheck, CI running `npm test`. | Metrics export (Prometheus) is left for later. |
| **UX** | Touch-first. Tap your name and enter a PIN to sign in. A combo meal is configured in one screen with defaults preselected. Quick-cash buttons. Keyboard `/` jumps to search. Dark KDS. Kiosk resets when idle. | — |

## Key rules encoded in the domain
- **Server-side pricing only.** Line prices come from the catalogue plus modifier deltas. Modifier min/max rules are enforced.
- **Sent to kitchen = consumed.** Stock is deducted when a line is sent (quick-service orders are sent automatically at payment). Removing a sent line needs manager approval and does not restock.
- **SC/PWD share.** The discount applies to the `sc_pwd_count / guest_count` share of eligible lines. VAT is removed first, then 20% is taken off. Other discounts only apply to the rest of the bill.
- **Cash accountability.** No payment is taken without an open shift. Expected cash = float + cash sales − cash refunds + pay-ins − payouts − drops.
- **Z-reading** is once per business date, requires every order and shift to be closed, and carries the grand total forward.

## Risks & mitigations
- *Experimental `node:sqlite` API changes* → Node version pinned in `engines`; all DB access goes through a thin wrapper.
- *Single store server is a single point of failure* → a WAL-safe backup procedure is documented. The browser clients hold no business state, so a replacement server can be brought up quickly.
- *Manager PIN brute force from a till* → approvals are rate-limited per user and IP. Every approval is audited.
