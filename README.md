# Albert NO.485 — independent restaurant website and admin

The website, booking service and admin run together on the existing Sites project. There are no embedded pages or operational dependencies on Wix.

## Pages and frontend

- `/`: the approved Albert homepage and transparent logos.
- `/meny/`, `/historien/`, `/avpn/`: complete restaurant content.
- `/boka-pizza/`: native date, count, dine-in/takeaway, guest-count and slot selection, contact details, review and saved confirmation.
- `/admin/`: native authenticated admin with three simple tabs: Dagsvy, Arbetsuppgifter and Historik. The day view combines bookings, check-in/finish/cancellation, large drop-in/waste counters with manual correction, daily stock and collapsible booking settings. Search, status filters and CSV export are retained.

`src/home.html` preserves the approved homepage. `python src/build_pages.py` generates the browser frontend in `public/`. Source interactions and styling are in `src/admin.*`, `src/booking.*`, `src/site.js`, and `src/pages.css`.

## Server and data

Vinext uses the supplied Sites build integration. The catch-all page handler serves the generated HTML. `app/api/[...path]/route.ts` owns JSON endpoints. Domain logic lives in `lib/restaurant.ts`.

D1 is declared as `DB` in `.openai/hosting.json`. Drizzle declares schema in `db/schema.ts`; generated schema-only migrations and metadata are in `drizzle/`. The new database starts empty. Existing external bookings were not migrated or altered.

Tables: `days`, `bookings`, `operators`, `tasks`, `audit`, `booking_emails`.

## Booking confirmation email

`lib/booking-email.ts` sends Swedish HTML and text confirmations through the Resend HTTPS API. The email contains the saved booking's date, ready/arrival times, pizza count, dine-in or takeaway details, seating period when applicable, address, phone and booking number. Guest content is HTML-escaped. The sender and recipient cannot be overridden by a public request.

**Activation is not complete yet:** no mail provider credentials or sender are currently configured. Production sends nothing until the required secrets from `.env.example` are configured through Sites and a new deployment applies that environment revision. The sender domain must be verified in Resend. Do not store an API key in source, browser code, chat examples or database records. The key should have only the sending access needed for the verified domain. An optional reply address can be supplied.

The schema-only `0002_elite_dakota_north.sql` migration adds `booking_emails`. New bookings and their pending confirmation are committed in one transaction. Existing bookings are not backfilled or mailed automatically. The owner can explicitly request a confirmation for a current existing booking from admin.

After a successful booking, the API attempts delivery with an 8-second timeout. Provider failures never roll back the booking. The guest sees whether the provider accepted the message and can always save the on-screen confirmation. `sent` means accepted by Resend, not verified inbox delivery; no delivery/bounce webhook is connected.

Each message has one persistent payload, an exclusive 30-second sending lease and a provider idempotency key based on the booking ID. Concurrency, lost responses and retries preserve that exact payload. Transient errors and provider backoff are recorded, with authenticated retry buttons in admin. Retries are user-triggered or triggered by a retry of the same booking submission; there is no background retry scheduler. Attempts older than 23 hours require review, before the provider's 24-hour deduplication window expires. Cancelled and past bookings do not send new confirmations. A sender change does not rewrite a previously attempted email: verify its saved sender before retrying.

Admin reads expose status only, not the stored HTML/text or credentials. `/api/admin/email` requires the same server-side owner authorization as other admin writes. It uses the saved booking contact, records the request and returns fresh day data. Customer-facing responses include only the coarse confirmation status.

No live email or production test booking has been sent. Credential validation, sender-domain verification and a real inbox delivery test remain required after activation. Unit/integration tests use mocked provider HTTP responses and the real SQLite migrations.

## Daily checklists

Tasks are organized first by time (Öppning, Under dagen, Stängning), then by area (Kök & förberedelser, Servering & lokal, Hygien & toalett, Övrigt). Each phase shows its completed count and progress. Filters can show one phase or only unfinished work. Tasks can be edited, moved, completed and soft-archived; changes stay in the audit history.

The owner can add an 18-task standard checklist for any selected day. Lists are created only on this explicit action, never by a read. The unique `(date, template_key)` index makes retries and concurrent starts safe and preserves completed, edited and archived tasks. Custom tasks and other dates are unaffected. Editing the standard list changes that day's tasks only. The schema-only `0001_wet_silver_fox.sql` migration adds an area (legacy tasks default to Övrigt), a nullable template key, and the index; no existing bookings, counters or tasks are deleted.

Public endpoints:

- `GET /api/availability?date=YYYY-MM-DD&count=2&mode=here&guests=2` returns available capacity without contact data.
- `POST /api/bookings` accepts a validated booking and requires an `Idempotency-Key` UUID. Successful retries of the same payload return the existing confirmation. A server-side conditional insert atomically protects slot, rolling-hour, daily-stock and overlapping-seat capacity.

Admin endpoints require platform-authenticated identity and explicit server-side authorization. They cover day reads, booking status changes, counter adjustments, daily settings and tasks. Writes also validate same-origin requests and record an audit entry. Numeric inputs are bounded and manual corrections require the current day version.

## Authentication

Sites owns ChatGPT sign-in and sign-out. No separate password/session service or BankID integration is present. `ADMIN_OWNER_EMAIL` is a protected runtime variable configured through Sites. The first authenticated matching owner is bound to the Site-stable user ID in `operators`; later checks use that ID. Missing identity returns 401; unrelated users return 403. The Site is currently public for the marketing and booking pages; admin APIs still require the owner identity. Preserve the current audience unless the user requests a change.

There are no credentials in source or browser code. No visitor/session tokens from another service are used.

## Booking rules

- Wednesday through Sunday; Monday and Tuesday closed.
- Ready times 12:15–14:30 and 16:45–21:00 in 15-minute intervals.
- Up to 8 pizzas per slot, 31 per rolling 60 minutes and 31 overlapping seated guests.
- Arrival 10 minutes before ready time; seating lasts 60 minutes from arrival.
- Late seating beyond the service close is offered only if enabled for that day.
- Book from today through 30 days ahead using Europe/Stockholm time.
- Optional daily prepared count; active bookings, drop-in and waste consume it. Empty means no daily stock limit. Slot/hour/seat limits still apply.
- Confirmation is displayed and can be saved as text. Email sending is implemented but awaits activation; SMS is not connected.

Cancellation releases reservation capacity; completed bookings still count as consumed pizza capacity but release seats. No bank, payment or email provider is connected. Guests choose pizza and pay at the restaurant.

## Build and validation

Dependencies use the image-supported pnpm setup. Use the Sites skill's `build-site.mjs` and source workflow for builds and deployment.

- `python src/build_pages.py`
- `npm run db:generate` after schema changes; inspect and commit generated SQL and metadata. Never alter applied migrations.
- `node --test tests/*.test.mjs` runs domain integration tests against SQLite using the actual migrations. Tests cover authorization, concurrent slot/hour/seat/stock capacity, idempotency, counters, stale corrections, cancellations, categorized checklists, mail concurrency/unknown outcomes/backoff, privacy and HTML/header injection handling.
- `node node_modules/typescript/bin/tsc --noEmit` checks TypeScript.

Browser visual QA was not available in this environment. No real restaurant booking or customer record was created for testing.
