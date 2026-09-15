"""PostgreSQL schema, connection helper, and first-run seed data.

Runs once at startup (see main.py's lifespan). All shared restaurant state
lives here now; the frontend only keeps per-browser UI state (which screen is
open, cart draft, form drafts) client-side.

Connects to DATABASE_URL — Render injects this automatically when a Postgres
database is linked to the web service; locally it defaults to the database
started by docker-compose.yml (`docker compose up -d`).
"""
import json
import os

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5433/qr_ordering"
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS shop (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  sales_today INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prefixes (
  id TEXT PRIMARY KEY,
  th TEXT NOT NULL,
  en TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  th TEXT NOT NULL,
  en TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  cat TEXT NOT NULL,
  kind TEXT NOT NULL,
  th TEXT NOT NULL,
  en TEXT NOT NULL,
  price INTEGER NOT NULL,
  dth TEXT NOT NULL DEFAULT '',
  den TEXT NOT NULL DEFAULT '',
  tth TEXT NOT NULL DEFAULT '',
  ten TEXT NOT NULL DEFAULT '',
  available INTEGER NOT NULL DEFAULT 1,
  has_spice INTEGER NOT NULL DEFAULT 1,
  photo TEXT,
  photo_v INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  phone TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS promos (
  id TEXT PRIMARY KEY,
  th TEXT NOT NULL,
  en TEXT NOT NULL,
  value INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  days TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  cat TEXT NOT NULL,
  note TEXT NOT NULL,
  amount INTEGER NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  table_no INTEGER NOT NULL,
  type TEXT NOT NULL,
  st TEXT NOT NULL,
  food TEXT NOT NULL,
  drink TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  cust_name TEXT NOT NULL DEFAULT '',
  cust_phone TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL,
  lines TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  cooking_at TEXT,
  ready_at TEXT,
  closed_at TEXT
);
"""


class Conn:
    """Thin sqlite3-shaped wrapper around a psycopg2 connection, so call sites
    can keep writing conn.execute(sql, params).fetchone()/.fetchall() and get
    dict-like rows back, same as before the Postgres migration."""

    def __init__(self, pg_conn):
        self._conn = pg_conn

    def execute(self, sql, params=()):
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, params)
        return cur

    def executemany(self, sql, seq_of_params):
        cur = self._conn.cursor()
        cur.executemany(sql, seq_of_params)
        cur.close()

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def get_db():
    return Conn(psycopg2.connect(DATABASE_URL))


def init_db():
    conn = get_db()
    conn.execute(SCHEMA)
    migrate(conn)
    conn.commit()
    if conn.execute("SELECT COUNT(*) c FROM shop").fetchone()["c"] == 0:
        seed(conn)
        conn.commit()
    conn.close()


def migrate(conn):
    """Additive, idempotent schema patches for a database created before a
    column existed — CREATE TABLE IF NOT EXISTS above only covers fresh installs."""
    cols = {
        r["column_name"]
        for r in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'menu_items'"
        ).fetchall()
    }
    if "has_spice" not in cols:
        conn.execute("ALTER TABLE menu_items ADD COLUMN has_spice INTEGER NOT NULL DEFAULT 1")
    if "photo" not in cols:
        conn.execute("ALTER TABLE menu_items ADD COLUMN photo TEXT")
    if "photo_v" not in cols:
        conn.execute("ALTER TABLE menu_items ADD COLUMN photo_v INTEGER NOT NULL DEFAULT 0")


def seed(conn):
    conn.execute("INSERT INTO shop (id, name, sales_today) VALUES (1, %s, %s)",
                 ("ร้านแวะหน่อยดิ By ชาพะยอม", 4820))
    conn.execute("INSERT INTO counters (name, value) VALUES ('order_seq', 1042)")

    conn.executemany(
        "INSERT INTO staff (username, password, role) VALUES (%s, %s, %s)",
        [
            ("staff", "staff123", "owner"),
            ("owner", "owner123", "manager"),
            ("kitchen", "kitchen123", "kitchen"),
            ("admin", "admin123", "admin"),
        ],
    )

    conn.executemany(
        "INSERT INTO prefixes (id, th, en, sort) VALUES (%s, %s, %s, %s)",
        [
            ("p1", "นาย", "Mr.", 0),
            ("p2", "นาง", "Mrs.", 1),
            ("p3", "นางสาว", "Ms.", 2),
        ],
    )

    cats = [
        ("rec", "แนะนำ", "Recommended"),
        ("rice", "จานเดียว", "One-dish"),
        ("dish", "กับข้าว", "Shared dishes"),
        ("drink", "เครื่องดื่ม", "Drinks"),
    ]
    conn.executemany(
        "INSERT INTO categories (id, th, en, sort) VALUES (%s, %s, %s, %s)",
        [(cid, th, en, i) for i, (cid, th, en) in enumerate(cats)],
    )

    menu = [
        ("f1", "rec", "food", "ผัดกะเพราหมูสับ", "Holy Basil Minced Pork", 60,
         "เผ็ดร้อน ใบกะเพราสด ราดข้าวสวย", "Hot basil stir-fry over jasmine rice", "ขายดี", "Best seller"),
        ("f2", "rec", "food", "ข้าวผัดกุ้ง", "Shrimp Fried Rice", 70,
         "กุ้งสด 5 ตัว เสิร์ฟกับมะนาว", "Five prawns, served with lime", "", ""),
        ("f3", "rice", "food", "ผัดซีอิ๊วหมู", "Pad See Ew, Pork", 60,
         "เส้นใหญ่ผัดไฟแรง คะน้าสด", "Wide noodles, high heat, kale", "", ""),
        ("f4", "rice", "food", "ข้าวหมูกระเทียม", "Garlic Pork over Rice", 60,
         "หมูหมักกระเทียมพริกไทย", "Garlic-pepper marinated pork", "", ""),
        ("f5", "rice", "food", "ไข่เจียวหมูสับ", "Minced Pork Omelette", 45,
         "ไข่ 2 ฟอง ฟูกรอบ", "Two eggs, crisp edges", "", ""),
        ("f6", "dish", "food", "ต้มยำทะเล", "Tom Yum Seafood", 120,
         "น้ำใส เผ็ดจัด กุ้ง หมึก", "Clear broth, prawn and squid", "เผ็ด", "Spicy"),
        ("f7", "dish", "food", "ผัดพริกแกงหมูกรอบ", "Red Curry Crispy Pork", 70,
         "หมูกรอบ ถั่วฝักยาว", "Crispy pork belly, long beans", "", ""),
        ("f8", "dish", "food", "คะน้าน้ำมันหอย", "Kale in Oyster Sauce", 55,
         "คะน้าฮ่องกงลวกน้ำมันหอย", "Hong Kong kale, oyster sauce", "", ""),
        ("d1", "drink", "drink", "ชาไทยเย็น", "Thai Iced Tea", 35,
         "ชานมเข้ม หวานมัน", "Strong milk tea", "ขายดี", "Best seller"),
        ("d2", "drink", "drink", "กาแฟเย็น", "Iced Coffee", 40,
         "คั่วเข้ม เสิร์ฟเย็น", "Dark roast, over ice", "", ""),
        ("d3", "drink", "drink", "น้ำมะนาวโซดา", "Lime Soda", 35,
         "มะนาวคั้นสด โซดาซ่า", "Fresh lime, soda", "", ""),
        ("d4", "drink", "drink", "โอเลี้ยง", "Iced Black Coffee", 30,
         "กาแฟดำโบราณ", "Old-style black coffee", "", ""),
        ("d5", "drink", "drink", "น้ำเปล่า", "Drinking Water", 10,
         "ขวด 600 มล.", "600 ml bottle", "", ""),
    ]
    conn.executemany(
        "INSERT INTO menu_items (id, cat, kind, th, en, price, dth, den, tth, ten, available, sort) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 1, %s)",
        [(*m, i) for i, m in enumerate(menu)],
    )
    # ข้าวผัดกุ้ง / ผัดซีอิ๊วหมู / ข้าวหมูกระเทียม ไม่มีตัวเลือกระดับความเผ็ด
    # น้ำเปล่า ไม่มีตัวเลือกระดับความหวานและเพิ่มพิเศษ (ใช้ has_spice flag เดียวกัน)
    conn.execute("UPDATE menu_items SET has_spice = 0 WHERE id IN ('f2', 'f3', 'f4', 'd5')")

    users = [
        ("u1", "สมชาย ใจดี", "server", "081-234-5678", 1),
        ("u2", "มาลี สุขใจ", "server", "082-345-6789", 1),
        ("u3", "ประยุทธ ทองคำ", "kitchen", "083-456-7890", 1),
        ("u4", "นภา ชื่นบาน", "bar", "084-567-8901", 0),
    ]
    conn.executemany(
        "INSERT INTO users (id, name, role, phone, active, sort) VALUES (%s, %s, %s, %s, %s, %s)",
        [(uid, name, role, phone, active, i) for i, (uid, name, role, phone, active) in enumerate(users)],
    )

    promos = [
        ("pr1", "พิเศษวันจันทร์ พุธ ศุกร์", "Mon / Wed / Fri special", 10, 1, [1, 3, 5]),
        ("pr2", "ชุดข้าว + เครื่องดื่ม", "Rice set + drink", 5, 1, [0, 1, 2, 3, 4, 5, 6]),
        ("pr3", "เสาร์-อาทิตย์ ลดเครื่องดื่ม", "Weekend drinks", 15, 0, [0, 6]),
    ]
    conn.executemany(
        "INSERT INTO promos (id, th, en, value, active, days, sort) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        [(pid, th, en, val, act, json.dumps(days), i) for i, (pid, th, en, val, act, days) in enumerate(promos)],
    )

    expenses = [
        ("e1", "2026-07-31", "วัตถุดิบ", "หมูสับ ไก่ กุ้ง", 1850),
        ("e2", "2026-07-31", "วัตถุดิบ", "ผักและเครื่องปรุง", 620),
        ("e3", "2026-07-30", "ค่าน้ำค่าไฟ", "ค่าไฟเดือนกรกฎาคม", 1980),
        ("e4", "2026-07-29", "ค่าจ้าง", "ค่าแรงพนักงาน 2 คน", 1400),
        ("e5", "2026-07-28", "อุปกรณ์", "แก้วพลาสติกและหลอด", 740),
    ]
    conn.executemany(
        "INSERT INTO expenses (id, date, cat, note, amount, sort) VALUES (%s, %s, %s, %s, %s, %s)",
        [(*e, i) for i, e in enumerate(expenses)],
    )

    def line(item_id, qty, opts, note, price, kind):
        return {"id": item_id, "qty": qty, "opts": opts, "note": note, "price": price, "kind": kind}

    orders = [
        ("A-1041", 1, "dinein", "accepted", "ready", "ready", "", "", "", "seed-demo",
         [line("f4", 2, [{"th": "เผ็ดน้อย", "en": "Mild"}], "", 60, "food"),
          line("d1", 2, [{"th": "หวานน้อย", "en": "Less sweet"}], "", 35, "drink")],
         "2026-08-27T17:58:00", "2026-08-27T17:59:00", "2026-08-27T18:03:00", "2026-08-27T18:10:00", None),
        ("A-1038", 2, "dinein", "accepted", "queued", "ready", "ขอช้อนเพิ่ม 2 ชุด", "", "", "seed-demo",
         [line("f6", 1, [{"th": "เผ็ดมาก", "en": "Very spicy"}], "ไม่ใส่หมึก", 120, "food"),
          line("f1", 2, [{"th": "เผ็ดกลาง", "en": "Medium"}, {"th": "ไข่ดาว", "en": "Fried egg"}], "", 70, "food"),
          line("d3", 2, [], "", 35, "drink")],
         "2026-08-27T18:06:00", "2026-08-27T18:07:00", "2026-08-27T18:12:00", None, None),
        ("A-1039", 5, "dinein", "accepted", "queued", "queued", "", "", "", "seed-demo",
         [line("f3", 1, [{"th": "เผ็ดน้อย", "en": "Mild"}], "", 60, "food"),
          line("f8", 1, [], "ไม่ใส่กระเทียม", 55, "food"),
          line("d2", 1, [{"th": "หวานปกติ", "en": "Standard"}], "", 40, "drink")],
         "2026-08-27T18:14:00", "2026-08-27T18:15:00", None, None, None),
        ("A-1040", 0, "takeaway", "new", "queued", "queued", "มารับ 18:45 ครับ", "คุณอรุณ", "089-111-2233", "seed-demo",
         [line("f2", 2, [{"th": "เผ็ดกลาง", "en": "Medium"}], "", 70, "food"),
          line("d4", 1, [{"th": "หวานน้อย", "en": "Less sweet"}], "", 30, "drink")],
         "2026-08-27T18:21:00", None, None, None, None),
        ("A-1032", 3, "dinein", "closed", "ready", "ready", "", "", "", "seed-demo",
         [line("f1", 1, [{"th": "เผ็ดกลาง", "en": "Medium"}, {"th": "ไข่ดาว", "en": "Fried egg"}], "", 70, "food"),
          line("d1", 1, [{"th": "หวานน้อย", "en": "Less sweet"}], "", 35, "drink")],
         "2026-07-30T12:40:00", "2026-07-30T12:41:00", "2026-07-30T12:45:00", "2026-07-30T12:55:00", "2026-07-30T13:10:00"),
        ("A-1021", 0, "takeaway", "closed", "ready", "ready", "", "", "", "seed-demo",
         [line("f7", 2, [{"th": "เผ็ดน้อย", "en": "Mild"}], "แยกข้าว", 70, "food"),
          line("f5", 1, [], "", 45, "food"),
          line("d3", 2, [], "", 35, "drink")],
         "2026-07-27T18:05:00", "2026-07-27T18:06:00", "2026-07-27T18:10:00", "2026-07-27T18:20:00", "2026-07-27T18:30:00"),
    ]
    conn.executemany(
        "INSERT INTO orders (id, table_no, type, st, food, drink, note, cust_name, cust_phone, client_id, "
        "lines, created_at, accepted_at, cooking_at, ready_at, closed_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        [(*o[:10], json.dumps(o[10], ensure_ascii=False), *o[11:]) for o in orders],
    )
