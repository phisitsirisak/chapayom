"""ระบบสั่งอาหาร QR — backend.

Owns every piece of shared restaurant state (menu, orders, staff, promos,
expenses) in PostgreSQL so every device — customer phones, the kitchen tablet,
the owner's screen — sees the same data. The frontend polls GET /api/state
and calls the action endpoints below; it keeps only per-browser UI state
(current screen, cart draft, form drafts) to itself.

Needs a running Postgres reachable at DATABASE_URL — see docker-compose.yml
for local dev.

Run with: uvicorn backend.main:app --host 0.0.0.0 --port 8000
"""
import json
import psycopg2
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db

ROOT = Path(__file__).resolve().parent.parent
MENU_PHOTO_DIR = ROOT / "images" / "menu"
PHOTO_EXT_BY_TYPE = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}
MAX_PHOTO_BYTES = 5 * 1024 * 1024

STATIONS = ("food", "drink")
LOCKED_KEYS = {"accepted", "ready", "closed", "cancelled"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="ระบบสั่งอาหาร QR", lifespan=lifespan)


def get_conn():
    conn = db.get_db()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def client_id(x_client_id: Optional[str] = Header(default=None)) -> str:
    return x_client_id or ""


# ── time formatting ──────────────────────────────────────────────────────
def fmt_at(iso: Optional[str]) -> Optional[str]:
    if not iso:
        return None
    dt = datetime.fromisoformat(iso)
    if dt.date() == datetime.now().date():
        return dt.strftime("%H:%M")
    return dt.strftime("%d/%m %H:%M")


def fmt_clock(iso: Optional[str]) -> Optional[str]:
    if not iso:
        return None
    return datetime.fromisoformat(iso).strftime("%H:%M")


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ── row -> JSON shaping (camelCase, matches the frontend's field names) ──
def order_json(row: dict, requester: str) -> dict:
    return {
        "id": row["id"],
        "table": row["table_no"],
        "type": row["type"],
        "st": row["st"],
        "food": row["food"],
        "drink": row["drink"],
        "note": row["note"],
        "custName": row["cust_name"],
        "custPhone": row["cust_phone"],
        "lines": json.loads(row["lines"]),
        "at": fmt_at(row["created_at"]),
        "acceptedAt": fmt_clock(row["accepted_at"]),
        "cookingAt": fmt_clock(row["cooking_at"]),
        "readyAt": fmt_clock(row["ready_at"]),
        "closedAt": fmt_clock(row["closed_at"]),
        "mine": row["client_id"] == requester,
    }


def menu_json(row: dict) -> dict:
    photo = f"{row['photo']}?v={row['photo_v']}" if row["photo"] else None
    return {k: row[k] for k in ("id", "cat", "kind", "th", "en", "price", "dth", "den", "tth", "ten")} | {
        "available": bool(row["available"]), "hasSpice": bool(row["has_spice"]), "photo": photo
    }


def promo_json(row: dict) -> dict:
    return {
        "id": row["id"], "th": row["th"], "en": row["en"], "value": row["value"],
        "active": bool(row["active"]), "days": json.loads(row["days"]),
    }


def user_json(row: dict) -> dict:
    return {
        "id": row["id"], "name": row["name"], "role": row["role"],
        "phone": row["phone"], "active": bool(row["active"]),
    }


def order_total(row: dict) -> int:
    return sum(l["price"] * l["qty"] for l in json.loads(row["lines"]))


def has_kind(row: dict, kind: str) -> bool:
    return any(l["kind"] == kind for l in json.loads(row["lines"]))


def ostatus(row: dict) -> str:
    if row["st"] != "accepted":
        return row["st"]
    active_kinds = [k for k in STATIONS if has_kind(row, k)]
    statuses = [row[k] for k in active_kinds]
    if statuses and all(s == "ready" for s in statuses):
        return "ready"
    return "accepted"


def get_order_or_404(conn, order_id: str) -> dict:
    row = conn.execute("SELECT * FROM orders WHERE id = %s", (order_id,)).fetchone()
    if not row:
        raise HTTPException(404, "order not found")
    return row


def next_seq(conn, name: str) -> int:
    conn.execute("UPDATE counters SET value = value + 1 WHERE name = %s", (name,))
    return conn.execute("SELECT value v FROM counters WHERE name = %s", (name,)).fetchone()["v"]


def new_id(prefix: str) -> str:
    import secrets
    return prefix + secrets.token_hex(3)


# ── auth ──────────────────────────────────────────────────────────────────
class LoginBody(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(body: LoginBody, conn=Depends(get_conn)):
    row = conn.execute(
        "SELECT * FROM staff WHERE username = %s", (body.username.strip().lower(),)
    ).fetchone()
    if not row or row["password"] != body.password:
        raise HTTPException(401, "invalid username or password")
    return {"role": row["role"]}


# ── full state snapshot ─────────────────────────────────────────────────
@app.get("/api/state")
def get_state(conn=Depends(get_conn), cid: str = Depends(client_id)):
    shop = conn.execute("SELECT * FROM shop WHERE id = 1").fetchone()
    orders = conn.execute("SELECT * FROM orders ORDER BY created_at DESC").fetchall()
    return {
        "shopName": shop["name"],
        "salesToday": shop["sales_today"],
        "prefixes": [dict(id=r["id"], th=r["th"], en=r["en"])
                     for r in conn.execute("SELECT * FROM prefixes ORDER BY sort").fetchall()],
        "categories": [dict(id=r["id"], th=r["th"], en=r["en"])
                       for r in conn.execute("SELECT * FROM categories ORDER BY sort").fetchall()],
        "menu": [menu_json(r) for r in conn.execute("SELECT * FROM menu_items ORDER BY sort").fetchall()],
        "users": [user_json(r) for r in conn.execute("SELECT * FROM users ORDER BY sort").fetchall()],
        "promos": [promo_json(r) for r in conn.execute("SELECT * FROM promos ORDER BY sort").fetchall()],
        "expenses": [dict(id=r["id"], date=r["date"], cat=r["cat"], note=r["note"], amount=r["amount"])
                     for r in conn.execute("SELECT * FROM expenses ORDER BY sort").fetchall()],
        "orders": [order_json(r, cid) for r in orders],
    }


# ── orders ────────────────────────────────────────────────────────────────
class OrderLine(BaseModel):
    id: str
    qty: int
    opts: list = []
    note: str = ""
    price: int
    kind: str


class CreateOrderBody(BaseModel):
    service: str
    tableNo: int = 0
    custName: str = ""
    custPhone: str = ""
    note: str = ""
    lines: list[OrderLine]


@app.post("/api/orders")
def create_order(body: CreateOrderBody, conn=Depends(get_conn), cid: str = Depends(client_id)):
    if not body.lines:
        raise HTTPException(400, "cart is empty")
    if body.service == "dinein" and not body.tableNo:
        raise HTTPException(400, "table required for dine-in")
    if body.service == "dinein":
        busy = conn.execute(
            "SELECT 1 FROM orders WHERE table_no = %s AND type = 'dinein' AND st IN ('new', 'accepted') LIMIT 1",
            (body.tableNo,),
        ).fetchone()
        if busy:
            raise HTTPException(409, "table_taken")
    order_id = "A-" + str(next_seq(conn, "order_seq"))
    lines = [l.model_dump() for l in body.lines]
    conn.execute(
        "INSERT INTO orders (id, table_no, type, st, food, drink, note, cust_name, cust_phone, "
        "client_id, lines, created_at) VALUES (%s, %s, %s, 'new', 'queued', 'queued', %s, %s, %s, %s, %s, %s)",
        (order_id, body.tableNo if body.service == "dinein" else 0, body.service,
         body.note, body.custName, body.custPhone, cid, json.dumps(lines, ensure_ascii=False), now_iso()),
    )
    return order_json(get_order_or_404(conn, order_id), cid)


class EditOrderBody(BaseModel):
    lines: list[OrderLine]
    note: str = ""
    custName: str = ""
    custPhone: str = ""


def assert_owned_and_unlocked(row: dict, cid: str):
    if row["client_id"] != cid:
        raise HTTPException(403, "not your order")
    if ostatus(row) in LOCKED_KEYS:
        raise HTTPException(409, "order is locked")


@app.patch("/api/orders/{order_id}")
def edit_order(order_id: str, body: EditOrderBody, conn=Depends(get_conn), cid: str = Depends(client_id)):
    row = get_order_or_404(conn, order_id)
    assert_owned_and_unlocked(row, cid)
    lines = [l.model_dump() for l in body.lines]
    conn.execute(
        "UPDATE orders SET lines = %s, note = %s, cust_name = %s, cust_phone = %s WHERE id = %s",
        (json.dumps(lines, ensure_ascii=False), body.note, body.custName, body.custPhone, order_id),
    )
    return order_json(get_order_or_404(conn, order_id), cid)


@app.post("/api/orders/{order_id}/cancel")
def cancel_order(order_id: str, conn=Depends(get_conn), cid: str = Depends(client_id)):
    row = get_order_or_404(conn, order_id)
    assert_owned_and_unlocked(row, cid)
    conn.execute("UPDATE orders SET st = 'cancelled' WHERE id = %s", (order_id,))
    return order_json(get_order_or_404(conn, order_id), cid)


@app.post("/api/orders/{order_id}/accept")
def accept_order(order_id: str, conn=Depends(get_conn), cid: str = Depends(client_id)):
    get_order_or_404(conn, order_id)
    conn.execute("UPDATE orders SET st = 'accepted', accepted_at = %s WHERE id = %s", (now_iso(), order_id))
    return order_json(get_order_or_404(conn, order_id), cid)


@app.post("/api/orders/{order_id}/reject")
def reject_order(order_id: str, conn=Depends(get_conn), cid: str = Depends(client_id)):
    get_order_or_404(conn, order_id)
    conn.execute("UPDATE orders SET st = 'cancelled' WHERE id = %s", (order_id,))
    return order_json(get_order_or_404(conn, order_id), cid)


class StatusBody(BaseModel):
    key: str


@app.post("/api/orders/{order_id}/status")
def jump_status(order_id: str, body: StatusBody, conn=Depends(get_conn), cid: str = Depends(client_id)):
    row = get_order_or_404(conn, order_id)
    key, stamp = body.key, now_iso()
    if key in ("new", "closed", "cancelled"):
        col = {"closed": "closed_at"}.get(key)
        if col:
            conn.execute(f"UPDATE orders SET st = %s, {col} = %s WHERE id = %s", (key, stamp, order_id))
        else:
            conn.execute("UPDATE orders SET st = %s WHERE id = %s", (key, order_id))
    else:
        cols, vals = ["st = 'accepted'"], []
        stamp_col = {"accepted": "accepted_at", "ready": "ready_at"}.get(key)
        if stamp_col:
            cols.append(f"{stamp_col} = %s")
            vals.append(stamp)
        station_val = "queued" if key == "accepted" else key
        for k in STATIONS:
            if has_kind(row, k):
                cols.append(f"{k} = %s")
                vals.append(station_val)
        vals.append(order_id)
        conn.execute(f"UPDATE orders SET {', '.join(cols)} WHERE id = %s", vals)
    return order_json(get_order_or_404(conn, order_id), cid)


class StationBody(BaseModel):
    kind: str
    action: str  # advance | undo


@app.post("/api/orders/{order_id}/station")
def station_action(order_id: str, body: StationBody, conn=Depends(get_conn), cid: str = Depends(client_id)):
    if body.kind not in STATIONS:
        raise HTTPException(400, "bad station")
    row = get_order_or_404(conn, order_id)
    current = row[body.kind]
    if body.action == "advance":
        if current == "ready":
            return order_json(row, cid)
        conn.execute(f"UPDATE orders SET {body.kind} = 'ready', ready_at = %s WHERE id = %s", (now_iso(), order_id))
    elif body.action == "undo":
        conn.execute(f"UPDATE orders SET {body.kind} = 'queued' WHERE id = %s", (order_id,))
    else:
        raise HTTPException(400, "bad action")
    return order_json(get_order_or_404(conn, order_id), cid)


class SwapBody(BaseModel):
    lineIdx: int
    newId: str


@app.post("/api/orders/{order_id}/swap")
def swap_line(order_id: str, body: SwapBody, conn=Depends(get_conn), cid: str = Depends(client_id)):
    row = get_order_or_404(conn, order_id)
    item = conn.execute("SELECT * FROM menu_items WHERE id = %s", (body.newId,)).fetchone()
    if not item:
        raise HTTPException(404, "menu item not found")
    lines = json.loads(row["lines"])
    if not (0 <= body.lineIdx < len(lines)):
        raise HTTPException(400, "bad line index")
    lines[body.lineIdx]["id"] = item["id"]
    lines[body.lineIdx]["price"] = item["price"]
    conn.execute("UPDATE orders SET lines = %s WHERE id = %s", (json.dumps(lines, ensure_ascii=False), order_id))
    return order_json(get_order_or_404(conn, order_id), cid)


@app.post("/api/orders/{order_id}/close")
def close_bill(order_id: str, conn=Depends(get_conn), cid: str = Depends(client_id)):
    row = get_order_or_404(conn, order_id)
    if ostatus(row) != "ready":
        raise HTTPException(409, "bill is not ready to close")
    total = order_total(row)
    conn.execute("UPDATE orders SET st = 'closed', closed_at = %s WHERE id = %s", (now_iso(), order_id))
    conn.execute("UPDATE shop SET sales_today = sales_today + %s WHERE id = 1", (total,))
    return order_json(get_order_or_404(conn, order_id), cid)


# ── menu ─────────────────────────────────────────────────────────────────
class MenuBody(BaseModel):
    th: str
    en: str = ""
    cat: str
    price: int
    hasSpice: bool = True


@app.post("/api/menu")
def add_menu(body: MenuBody, conn=Depends(get_conn)):
    mid = new_id("m")
    kind = "drink" if body.cat == "drink" else "food"
    n = conn.execute("SELECT COUNT(*) c FROM menu_items").fetchone()["c"]
    conn.execute(
        "INSERT INTO menu_items (id, cat, kind, th, en, price, available, has_spice, sort) "
        "VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s)",
        (mid, body.cat, kind, body.th, body.en or body.th, body.price, int(body.hasSpice), n),
    )
    return menu_json(conn.execute("SELECT * FROM menu_items WHERE id = %s", (mid,)).fetchone())


class AvailBody(BaseModel):
    available: bool


@app.patch("/api/menu/{item_id}")
def toggle_menu(item_id: str, body: AvailBody, conn=Depends(get_conn)):
    conn.execute("UPDATE menu_items SET available = %s WHERE id = %s", (int(body.available), item_id))
    row = conn.execute("SELECT * FROM menu_items WHERE id = %s", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "menu item not found")
    return menu_json(row)


@app.delete("/api/menu/{item_id}")
def delete_menu(item_id: str, conn=Depends(get_conn)):
    conn.execute("DELETE FROM menu_items WHERE id = %s", (item_id,))
    for old in MENU_PHOTO_DIR.glob(f"{item_id}.*"):
        old.unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/menu/{item_id}/photo")
async def upload_menu_photo(item_id: str, file: UploadFile = File(...)):
    ext = PHOTO_EXT_BY_TYPE.get(file.content_type)
    if not ext:
        raise HTTPException(400, "unsupported image type — use JPEG, PNG, WEBP or GIF")
    content = await file.read()
    if len(content) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "image too large — 5MB max")

    # Managed by hand rather than Depends(get_conn): this route is `async def`
    # (needs `await file.read()`), so FastAPI runs it on the event loop thread,
    # while a sync Depends generator gets dispatched to a worker thread — two
    # different threads touching one sqlite3 connection, which it forbids.
    conn = db.get_db()
    try:
        row = conn.execute("SELECT * FROM menu_items WHERE id = %s", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "menu item not found")

        MENU_PHOTO_DIR.mkdir(parents=True, exist_ok=True)
        for old in MENU_PHOTO_DIR.glob(f"{item_id}.*"):  # drop a previous photo even if its extension differed
            old.unlink(missing_ok=True)
        (MENU_PHOTO_DIR / f"{item_id}.{ext}").write_bytes(content)

        conn.execute(
            "UPDATE menu_items SET photo = %s, photo_v = photo_v + 1 WHERE id = %s",
            (f"/images/menu/{item_id}.{ext}", item_id),
        )
        conn.commit()
        return menu_json(conn.execute("SELECT * FROM menu_items WHERE id = %s", (item_id,)).fetchone())
    finally:
        conn.close()


# ── categories ───────────────────────────────────────────────────────────
class NameBody(BaseModel):
    th: str
    en: str = ""


@app.post("/api/categories")
def add_category(body: NameBody, conn=Depends(get_conn)):
    cid = new_id("c")
    n = conn.execute("SELECT COUNT(*) c FROM categories").fetchone()["c"]
    conn.execute("INSERT INTO categories (id, th, en, sort) VALUES (%s, %s, %s, %s)",
                 (cid, body.th, body.en or body.th, n))
    return {"id": cid, "th": body.th, "en": body.en or body.th}


@app.delete("/api/categories/{cat_id}")
def delete_category(cat_id: str, conn=Depends(get_conn)):
    conn.execute("DELETE FROM categories WHERE id = %s", (cat_id,))
    return {"ok": True}


# ── prefixes ─────────────────────────────────────────────────────────────
@app.post("/api/prefixes")
def add_prefix(body: NameBody, conn=Depends(get_conn)):
    pid = new_id("p")
    n = conn.execute("SELECT COUNT(*) c FROM prefixes").fetchone()["c"]
    conn.execute("INSERT INTO prefixes (id, th, en, sort) VALUES (%s, %s, %s, %s)",
                 (pid, body.th, body.en or body.th, n))
    return {"id": pid, "th": body.th, "en": body.en or body.th}


@app.delete("/api/prefixes/{prefix_id}")
def delete_prefix(prefix_id: str, conn=Depends(get_conn)):
    conn.execute("DELETE FROM prefixes WHERE id = %s", (prefix_id,))
    return {"ok": True}


# ── users ────────────────────────────────────────────────────────────────
class UserBody(BaseModel):
    name: str
    role: str
    phone: str = ""


@app.post("/api/users")
def add_user(body: UserBody, conn=Depends(get_conn)):
    uid = new_id("u")
    n = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    conn.execute("INSERT INTO users (id, name, role, phone, active, sort) VALUES (%s, %s, %s, %s, 1, %s)",
                 (uid, body.name, body.role, body.phone or "—", n))
    return user_json(conn.execute("SELECT * FROM users WHERE id = %s", (uid,)).fetchone())


class ActiveBody(BaseModel):
    active: bool


@app.patch("/api/users/{user_id}")
def toggle_user(user_id: str, body: ActiveBody, conn=Depends(get_conn)):
    conn.execute("UPDATE users SET active = %s WHERE id = %s", (int(body.active), user_id))
    row = conn.execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "user not found")
    return user_json(row)


@app.delete("/api/users/{user_id}")
def delete_user(user_id: str, conn=Depends(get_conn)):
    conn.execute("DELETE FROM users WHERE id = %s", (user_id,))
    return {"ok": True}


# ── promos ───────────────────────────────────────────────────────────────
class PromoBody(BaseModel):
    th: str
    value: int = 0


@app.post("/api/promos")
def add_promo(body: PromoBody, conn=Depends(get_conn)):
    pid = new_id("pr")
    n = conn.execute("SELECT COUNT(*) c FROM promos").fetchone()["c"]
    conn.execute(
        "INSERT INTO promos (id, th, en, value, active, days, sort) VALUES (%s, %s, %s, %s, 1, %s, %s)",
        (pid, body.th, body.th, body.value, json.dumps([1, 3, 5]), n),
    )
    return promo_json(conn.execute("SELECT * FROM promos WHERE id = %s", (pid,)).fetchone())


class PromoPatchBody(BaseModel):
    active: Optional[bool] = None
    toggleDay: Optional[int] = None


@app.patch("/api/promos/{promo_id}")
def patch_promo(promo_id: str, body: PromoPatchBody, conn=Depends(get_conn)):
    row = conn.execute("SELECT * FROM promos WHERE id = %s", (promo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "promo not found")
    if body.active is not None:
        conn.execute("UPDATE promos SET active = %s WHERE id = %s", (int(body.active), promo_id))
    if body.toggleDay is not None:
        days = json.loads(row["days"])
        days = [d for d in days if d != body.toggleDay] if body.toggleDay in days else sorted(days + [body.toggleDay])
        conn.execute("UPDATE promos SET days = %s WHERE id = %s", (json.dumps(days), promo_id))
    return promo_json(conn.execute("SELECT * FROM promos WHERE id = %s", (promo_id,)).fetchone())


@app.delete("/api/promos/{promo_id}")
def delete_promo(promo_id: str, conn=Depends(get_conn)):
    conn.execute("DELETE FROM promos WHERE id = %s", (promo_id,))
    return {"ok": True}


# ── expenses ─────────────────────────────────────────────────────────────
class ExpenseBody(BaseModel):
    date: str
    cat: str
    note: str = ""
    amount: int


@app.post("/api/expenses")
def add_expense(body: ExpenseBody, conn=Depends(get_conn)):
    eid = new_id("e")
    n = conn.execute("SELECT COUNT(*) c FROM expenses").fetchone()["c"]
    conn.execute("INSERT INTO expenses (id, date, cat, note, amount, sort) VALUES (%s, %s, %s, %s, %s, %s)",
                 (eid, body.date, body.cat, body.note or "—", body.amount, n))
    return {"id": eid, "date": body.date, "cat": body.cat, "note": body.note or "—", "amount": body.amount}


@app.delete("/api/expenses/{expense_id}")
def delete_expense(expense_id: str, conn=Depends(get_conn)):
    conn.execute("DELETE FROM expenses WHERE id = %s", (expense_id,))
    return {"ok": True}


@app.exception_handler(psycopg2.IntegrityError)
def integrity_error_handler(request, exc):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


# ── static frontend ──────────────────────────────────────────────────────
# Only the asset folders the page actually references are exposed — not the
# whole project root, so backend/app.db (customer names, phone numbers) and
# the venv never become web-reachable.
@app.get("/")
def index_page():
    return FileResponse(ROOT / "index.html")


for folder in ("css", "js", "images"):
    app.mount(f"/{folder}", StaticFiles(directory=ROOT / folder), name=folder)
