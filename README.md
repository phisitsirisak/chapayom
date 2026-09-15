# ระบบสั่งอาหาร QR — QR ordering system

A single-QR restaurant ordering system: guests scan one code anywhere in the
shop, land on the shop website, pick a service type and table, order, and track
the kitchen in real time. Staff, kitchen and management screens live behind a
sign-in on the same app. Every screen — a guest's phone, the kitchen tablet,
the owner's laptop — talks to one shared backend, so an order placed on one
device shows up on the others within a few seconds automatically.

Implemented from the Claude Design project **ระบบจัดการร้านอาหาร**
(`ระบบสั่งอาหาร QR.dc.html`), using the Modernist design system.

## Running

```bash
python -m venv .venv
.venv/Scripts/pip install -r backend/requirements.txt
.venv/Scripts/python -m uvicorn backend.main:app --host 0.0.0.0 --port 5175
```

Then visit http://localhost:5175. `--host 0.0.0.0` also makes it reachable
from other devices on the same network at `http://<your-LAN-IP>:5175`.

The first run creates `backend/app.db` (SQLite) and seeds it with demo menu,
orders, and staff accounts. Delete that file to reset to a clean seed.

## Sign-in

The staff sign-in is in the header. Demo accounts:

| User      | Password     | Lands on                                          |
| --------- | ------------ | ------------------------------------------------- |
| `staff`   | `staff123`   | Order taking — queue, floor plan, bills            |
| `owner`   | `owner123`   | Dashboard, menu, promotions, expenses              |
| `kitchen` | `kitchen123` | Kitchen + bar prep queue, two columns              |
| `admin`   | `admin123`   | The above plus base data and user accounts         |

## Layout

```
index.html            shell
css/modernist.css     design-system tokens, vendored from the design project
css/app.css            app layout and typography
js/i18n.js             Thai + English copy decks
js/data.js             client-only option lists (spice levels, add-ons, table numbers)
js/app.js               state, API calls, polling, rendering

backend/main.py         FastAPI app — every endpoint, all business rules
backend/db.py            SQLite schema + first-run seed data
backend/app.db           the database (created on first run, gitignore this)
backend/requirements.txt fastapi, uvicorn, python-multipart

images/                shop photo + uploaded menu photos (images/menu/)
```

**Frontend.** `js/app.js` holds one state object `S`; every mutation calls
`render()`, which rebuilds `#root` and rebinds through event delegation on
`data-act`. Text inputs write to `S` *without* re-rendering, so typing never
loses the caret. Per-state colours (awaiting / cooking / ready …) are set
inline from `statusChip()` rather than in CSS, matching how the design drives
them.

**Backend.** FastAPI + SQLite owns every piece of shared state — menu,
categories, orders, staff, promos, expenses. The frontend fetches
`GET /api/state` on load and every ~2.5s after (paused while a text field has
focus, so a poll never rips the cursor out of a note you're typing), and calls
an action endpoint (`POST /api/orders/{id}/accept`, `PATCH /api/menu/{id}`,
…) for every mutation. Polling was chosen over WebSockets deliberately: it's
far simpler to get right, and it survives ngrok/network hiccups on its own —
a few seconds of latency doesn't matter for a restaurant queue.

**Order ownership.** There's no customer login, so each browser gets a random
id (`localStorage`, generated once) sent as `X-Client-Id` on every request.
The server stamps new orders with it and uses it to compute `mine` on every
order returned, and to reject (`403`) an edit or cancel on an order that
belongs to a different browser. This is what "your order" / "your history" is
built on now that real customers use their own phones concurrently — the
original single-session mock just used a shared `mine: true/false` flag,
which only worked because everyone shared one browser tab.

## Order lifecycle

```
new ──accept──> accepted ──┬─ food:  queued -> cooking -> ready ─┬──> closed
                           └─ drink: queued -> cooking -> ready ─┘
```

An order's overall status is the slowest station it still has lines at
(computed both server-side, for the close-bill guard, and client-side, for
display). Guests may edit or cancel only while the status is `new` or
`accepted` — once the kitchen starts cooking, the server rejects further
edits with `409` and the buttons lock. A bill can only be closed once every
station is `ready`. Every status change is timestamped for real
(`accepted_at`, `cooking_at`, `ready_at`, `closed_at`) and shown on the
tracking screen — the original mock's step times were fixed placeholders
(`18:26`, `18:38`, …).

## Menu photos

In the admin/owner menu tab, the small square next to each item's name is a
photo picker — click it to upload or replace that item's photo (JPEG/PNG/
WEBP/GIF, 5MB max). It shows up immediately on the guest-facing menu list and
item detail screen; items without a photo keep the hatched placeholder.
Uploads are saved to `images/menu/<item-id>.<ext>` and the DB just stores
that path plus a version counter used to cache-bust the URL on replace.

## Known simplifications

- **Line prices are trusted from the client**, same as the original all-client
  mock. There's no online payment (`payAtCounter` — cash at the counter), and
  staff sees the full bill before charging, so this isn't a new exposure —
  just flagging it stayed as-is rather than rebuilding the options/pricing
  model to be server-derived.
- **Staff sign-in has no session/token** — a successful login just tells the
  browser which role screen to show. Fine for a small internal system on a
  private network; would need real sessions before exposing admin actions
  past a trusted LAN.
- **Static assets are exposed at `/css`, `/js`, `/images` only** — the rest of
  the project root (`backend/app.db`, `.venv/`) is never mounted, so the
  database and its customer names/phone numbers aren't web-reachable.

## Notes on the implementation

Three places where the implementation goes past the design mock:

- **Kitchen screen sizing.** The design fitted a fixed 1180px board with a
  `ResizeObserver` + `transform: scale()`. Here the two columns are a real
  responsive grid that stacks below 820px, so text stays at full size.
- **One menu catalogue.** The design kept the guest menu and the admin menu as
  separate lists, so admin edits never reached guests. They are now one list —
  items paused with *งดขาย* disappear from the guest menu, and items added in
  the admin panel show up there.
- **Reachable roles.** The design defined `admin` and `kitchen` screens that no
  credential could open. Both now have demo accounts.
