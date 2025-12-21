FILE: README.md
# Släktträdet (GitHub) – Auth + Träd + Roller (RBAC)

Det här repot är ett lärprojekt som nu innehåller:

✅ Autentisering (konto, login, logout, /me)  
✅ Släktträd som objekt (`trees`)  
✅ Medlemskap per träd med roller (RBAC): `OWNER`, `EDITOR`, `VIEWER`  
✅ Släktkort + relationer kopplas till `treeId` (inte direkt till user)

## Roller (låst)
- OWNER: full åtkomst + får bjuda in andra till trädet
- EDITOR: kan skapa/ändra/ta bort släktkort och relationer
- VIEWER: kan bara läsa

## API-översikt (backend)
Auth:
- POST /auth/register
- POST /auth/login
- POST /auth/logout
- GET  /me

Trees:
- GET  /trees
- POST /trees

Members (OWNER only):
- GET  /trees/:treeId/members
- POST /trees/:treeId/members   { email, role }

Släktkort:
- GET    /trees/:treeId/slaktkort        (OWNER/EDITOR/VIEWER)
- POST   /trees/:treeId/slaktkort        (OWNER/EDITOR)
- DELETE /trees/:treeId/slaktkort/:id    (OWNER/EDITOR)

Relationer:
- GET    /trees/:treeId/relationer       (OWNER/EDITOR/VIEWER)
- POST   /trees/:treeId/relationer       (OWNER/EDITOR)
- DELETE /trees/:treeId/relationer/:id   (OWNER/EDITOR)

## Viktigt
Frontend (HTML) kan ligga på GitHub Pages.
Backend kan inte driftas permanent på GitHub Pages – men koden ligger här och kan köras i en riktig miljö/Codespaces senare.

FILE: .gitignore
node_modules
.env
server/data.sqlite
server/data.sqlite-journal

FILE: .env.example
PORT=3001
JWT_SECRET=CHANGE_ME_TO_A_LONG_RANDOM_SECRET
COOKIE_NAME=slakttradet_token

FILE: server/package.json
{
  "name": "slakttradet-server",
  "version": "1.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node src/index.js",
    "start": "node src/index.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.5.0",
    "cookie-parser": "^1.4.6",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "jsonwebtoken": "^9.0.2"
  }
}

FILE: server/src/index.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- Config --------------------
const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "";
const COOKIE_NAME = process.env.COOKIE_NAME || "slakttradet_token";

if (!JWT_SECRET || JWT_SECRET === "CHANGE_ME_TO_A_LONG_RANDOM_SECRET") {
  console.error("ERROR: JWT_SECRET saknas eller är inte bytt. Sätt i .env");
  process.exit(1);
}

// -------------------- DB (SQLite) --------------------
const dbPath = path.join(__dirname, "..", "data.sqlite");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

// Users
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    displayName TEXT NOT NULL,
    passwordHash TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
`);

// Trees
db.exec(`
  CREATE TABLE IF NOT EXISTS trees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
`);

// Tree members (RBAC per tree)
db.exec(`
  CREATE TABLE IF NOT EXISTS tree_members (
    treeId INTEGER NOT NULL,
    userId INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('OWNER','EDITOR','VIEWER')),
    createdAt TEXT NOT NULL,
    PRIMARY KEY (treeId, userId),
    FOREIGN KEY (treeId) REFERENCES trees(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tree_members_user ON tree_members(userId);`);

// Släktkort (per tree)
db.exec(`
  CREATE TABLE IF NOT EXISTS slaktkort (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    treeId INTEGER NOT NULL,
    fornamn TEXT NOT NULL,
    efternamn TEXT NOT NULL,
    kon TEXT NOT NULL CHECK(kon IN ('Man','Kvinna','Okänt')),
    fodelsear INTEGER,
    dodsar INTEGER,
    plats TEXT,
    anteckning TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (treeId) REFERENCES trees(id) ON DELETE CASCADE
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_slaktkort_tree ON slaktkort(treeId);`);

// Relationer (per tree)
db.exec(`
  CREATE TABLE IF NOT EXISTS relationer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    treeId INTEGER NOT NULL,
    typ TEXT NOT NULL CHECK(typ IN ('FORALDER_BARN')),
    franPersonId INTEGER NOT NULL,
    tillPersonId INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (treeId) REFERENCES trees(id) ON DELETE CASCADE,
    FOREIGN KEY (franPersonId) REFERENCES slaktkort(id) ON DELETE CASCADE,
    FOREIGN KEY (tillPersonId) REFERENCES slaktkort(id) ON DELETE CASCADE
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_relationer_tree ON relationer(treeId);`);

// -------------------- App --------------------
const app = express();

app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(express.json({ limit: "80kb" }));
app.use(cookieParser());

// -------------------- Helpers --------------------
function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isEmailLike(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email, displayName: user.displayName },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // produktion: true (https)
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: false
  });
}

function authGuard(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }
}

function asInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function roleRank(role) {
  // högre = mer rättigheter
  if (role === "OWNER") return 3;
  if (role === "EDITOR") return 2;
  if (role === "VIEWER") return 1;
  return 0;
}

function getUserId(req) {
  const id = asInt(req.user?.sub);
  return id;
}

function getMembership(treeId, userId) {
  return db
    .prepare("SELECT treeId, userId, role FROM tree_members WHERE treeId = ? AND userId = ?")
    .get(treeId, userId);
}

function requireTreeRole(minRole) {
  // minRole: "VIEWER" | "EDITOR" | "OWNER"
  return (req, res, next) => {
    const treeId = asInt(req.params.treeId);
    if (!treeId) return res.status(400).json({ error: "INVALID_TREE_ID" });

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

    const membership = getMembership(treeId, userId);
    if (!membership) return res.status(403).json({ error: "NOT_A_MEMBER" });

    if (roleRank(membership.role) < roleRank(minRole)) {
      return res.status(403).json({ error: "INSUFFICIENT_ROLE", need: minRole, have: membership.role });
    }

    req.tree = { id: treeId };
    req.membership = membership;
    next();
  };
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

// ---------- AUTH ----------
app.post("/auth/register", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const displayName = String(req.body?.displayName || "").trim();

  if (!email || !password || !displayName) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }
  if (!isEmailLike(email)) return res.status(400).json({ error: "INVALID_EMAIL" });
  if (password.length < 8) return res.status(400).json({ error: "WEAK_PASSWORD", minLength: 8 });
  if (displayName.length < 2 || displayName.length > 60) {
    return res.status(400).json({ error: "INVALID_DISPLAYNAME" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "EMAIL_ALREADY_EXISTS" });

  const passwordHash = await bcrypt.hash(password, 12);
  const info = db
    .prepare("INSERT INTO users (email, displayName, passwordHash, createdAt) VALUES (?, ?, ?, ?)")
    .run(email, displayName, passwordHash, nowIso());

  const user = { id: info.lastInsertRowid, email, displayName };
  const token = signToken(user);
  setAuthCookie(res, token);

  return res.status(201).json({ ok: true, user: { id: String(user.id), email, displayName } });
});

app.post("/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!email || !password) return res.status(400).json({ error: "MISSING_FIELDS" });

  const row = db
    .prepare("SELECT id, email, displayName, passwordHash FROM users WHERE email = ?")
    .get(email);
  if (!row) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  const ok = await bcrypt.compare(password, row.passwordHash);
  if (!ok) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  const user = { id: row.id, email: row.email, displayName: row.displayName };
  const token = signToken(user);
  setAuthCookie(res, token);

  return res.json({ ok: true, user: { id: String(user.id), email: user.email, displayName: user.displayName } });
});

app.post("/auth/logout", (req, res) => {
  clearAuthCookie(res);
  return res.json({ ok: true });
});

app.get("/me", authGuard, (req, res) => {
  return res.json({
    ok: true,
    me: { id: req.user.sub, email: req.user.email, displayName: req.user.displayName }
  });
});

// ---------- TREES ----------
app.get("/trees", authGuard, (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  const rows = db.prepare(`
    SELECT t.id, t.name, t.createdAt, m.role
    FROM trees t
    JOIN tree_members m ON m.treeId = t.id
    WHERE m.userId = ?
    ORDER BY t.id DESC
  `).all(userId);

  return res.json({ ok: true, trees: rows.map(r => ({ ...r, id: String(r.id) })) });
});

app.post("/trees", authGuard, (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  const name = String(req.body?.name || "").trim();
  if (!name || name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: "INVALID_TREE_NAME" });
  }

  const tx = db.transaction(() => {
    const tInfo = db.prepare("INSERT INTO trees (name, createdAt) VALUES (?, ?)").run(name, nowIso());
    const treeId = tInfo.lastInsertRowid;

    db.prepare("INSERT INTO tree_members (treeId, userId, role, createdAt) VALUES (?, ?, 'OWNER', ?)")
      .run(treeId, userId, nowIso());

    return treeId;
  });

  const treeId = tx();
  return res.status(201).json({ ok: true, tree: { id: String(treeId), name } });
});

// ---------- MEMBERS (OWNER only) ----------
app.get("/trees/:treeId/members", authGuard, requireTreeRole("OWNER"), (req, res) => {
  const treeId = req.tree.id;

  const rows = db.prepare(`
    SELECT u.id as userId, u.email, u.displayName, m.role, m.createdAt
    FROM tree_members m
    JOIN users u ON u.id = m.userId
    WHERE m.treeId = ?
    ORDER BY m.createdAt ASC
  `).all(treeId);

  return res.json({
    ok: true,
    members: rows.map(r => ({ ...r, userId: String(r.userId) }))
  });
});

app.post("/trees/:treeId/members", authGuard, requireTreeRole("OWNER"), (req, res) => {
  const treeId = req.tree.id;

  const email = normalizeEmail(req.body?.email);
  const role = String(req.body?.role || "").trim().toUpperCase();

  if (!email || !isEmailLike(email)) return res.status(400).json({ error: "INVALID_EMAIL" });
  if (!["OWNER", "EDITOR", "VIEWER"].includes(role)) return res.status(400).json({ error: "INVALID_ROLE" });

  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });

  const exists = db
    .prepare("SELECT treeId, userId FROM tree_members WHERE treeId = ? AND userId = ?")
    .get(treeId, user.id);
  if (exists) return res.status(409).json({ error: "ALREADY_MEMBER" });

  db.prepare("INSERT INTO tree_members (treeId, userId, role, createdAt) VALUES (?, ?, ?, ?)")
    .run(treeId, user.id, role, nowIso());

  return res.status(201).json({ ok: true, member: { treeId: String(treeId), userId: String(user.id), role } });
});

// ---------- SLÄKTKORT ----------
app.get("/trees/:treeId/slaktkort", authGuard, requireTreeRole("VIEWER"), (req, res) => {
  const treeId = req.tree.id;

  const rows = db.prepare(`
    SELECT id, fornamn, efternamn, kon, fodelsear, dodsar, plats, anteckning, createdAt
    FROM slaktkort
    WHERE treeId = ?
    ORDER BY id ASC
  `).all(treeId);

  return res.json({ ok: true, slaktkort: rows.map(r => ({ ...r, id: String(r.id) })) });
});

app.post("/trees/:treeId/slaktkort", authGuard, requireTreeRole("EDITOR"), (req, res) => {
  const treeId = req.tree.id;

  const fornamn = String(req.body?.fornamn || "").trim();
  const efternamn = String(req.body?.efternamn || "").trim();
  const kon = String(req.body?.kon || "Okänt").trim();
  const fodelsear = req.body?.fodelsear === null || req.body?.fodelsear === undefined ? null : Number(req.body.fodelsear);
  const dodsar = req.body?.dodsar === null || req.body?.dodsar === undefined ? null : Number(req.body.dodsar);
  const plats = String(req.body?.plats || "").trim();
  const anteckning = String(req.body?.anteckning || "").trim();

  if (!fornamn || !efternamn) return res.status(400).json({ error: "MISSING_NAME" });
  if (!["Man", "Kvinna", "Okänt"].includes(kon)) return res.status(400).json({ error: "INVALID_KON" });

  function yearOrNull(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return null;
    if (!Number.isInteger(n) || n < 0 || n > 9999) return "__INVALID__";
    return n;
  }

  const fy = yearOrNull(fodelsear);
  const dy = yearOrNull(dodsar);
  if (fy === "__INVALID__" || dy === "__INVALID__") return res.status(400).json({ error: "INVALID_YEAR" });

  const info = db.prepare(`
    INSERT INTO slaktkort (treeId, fornamn, efternamn, kon, fodelsear, dodsar, plats, anteckning, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(treeId, fornamn, efternamn, kon, fy, dy, plats || null, anteckning || null, nowIso());

  const id = info.lastInsertRowid;
  return res.status(201).json({ ok: true, slaktkort: { id: String(id) } });
});

app.delete("/trees/:treeId/slaktkort/:id", authGuard, requireTreeRole("EDITOR"), (req, res) => {
  const treeId = req.tree.id;
  const id = asInt(req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_ID" });

  const row = db.prepare("SELECT id FROM slaktkort WHERE id = ? AND treeId = ?").get(id, treeId);
  if (!row) return res.status(404).json({ error: "NOT_FOUND" });

  // Relationer som pekar på släktkort tas bort automatiskt via FK ON DELETE CASCADE
  db.prepare("DELETE FROM slaktkort WHERE id = ? AND treeId = ?").run(id, treeId);

  return res.json({ ok: true });
});

// ---------- RELATIONER ----------
app.get("/trees/:treeId/relationer", authGuard, requireTreeRole("VIEWER"), (req, res) => {
  const treeId = req.tree.id;

  const rows = db.prepare(`
    SELECT id, typ, franPersonId, tillPersonId, createdAt
    FROM relationer
    WHERE treeId = ?
    ORDER BY id ASC
  `).all(treeId);

  return res.json({
    ok: true,
    relationer: rows.map(r => ({ ...r, id: String(r.id) }))
  });
});

app.post("/trees/:treeId/relationer", authGuard, requireTreeRole("EDITOR"), (req, res) => {
  const treeId = req.tree.id;

  const typ = String(req.body?.typ || "").trim();
  const franPersonId = asInt(req.body?.franPersonId);
  const tillPersonId = asInt(req.body?.tillPersonId);

  if (typ !== "FORALDER_BARN") return res.status(400).json({ error: "INVALID_RELATION_TYPE" });
  if (!franPersonId || !tillPersonId) return res.status(400).json({ error: "MISSING_PERSON_IDS" });
  if (franPersonId === tillPersonId) return res.status(400).json({ error: "SELF_RELATION_NOT_ALLOWED" });

  // Båda personer måste finnas i samma tree
  const p1 = db.prepare("SELECT id FROM slaktkort WHERE id = ? AND treeId = ?").get(franPersonId, treeId);
  const p2 = db.prepare("SELECT id FROM slaktkort WHERE id = ? AND treeId = ?").get(tillPersonId, treeId);
  if (!p1 || !p2) return res.status(400).json({ error: "PERSON_NOT_IN_TREE" });

  // Max 2 föräldrar per barn (låst regel)
  const parentCount = db.prepare(`
    SELECT COUNT(1) as c
    FROM relationer
    WHERE treeId = ? AND typ = 'FORALDER_BARN' AND tillPersonId = ?
  `).get(treeId, tillPersonId)?.c || 0;

  if (parentCount >= 2) return res.status(409).json({ error: "MAX_PARENTS_REACHED", max: 2 });

  // Enkel cirkelregel (minimal): Förhindra direkt omvänd relation (barn->förälder redan finns)
  const reverse = db.prepare(`
    SELECT id FROM relationer
    WHERE treeId = ? AND typ = 'FORALDER_BARN' AND franPersonId = ? AND tillPersonId = ?
  `).get(treeId, tillPersonId, franPersonId);
  if (reverse) return res.status(409).json({ error: "CYCLE_NOT_ALLOWED_MINIMAL" });

  const info = db.prepare(`
    INSERT INTO relationer (treeId, typ, franPersonId, tillPersonId, createdAt)
    VALUES (?, 'FORALDER_BARN', ?, ?, ?)
  `).run(treeId, franPersonId, tillPersonId, nowIso());

  return res.status(201).json({ ok: true, relation: { id: String(info.lastInsertRowid) } });
});

app.delete("/trees/:treeId/relationer/:id", authGuard, requireTreeRole("EDITOR"), (req, res) => {
  const treeId = req.tree.id;
  const id = asInt(req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_ID" });

  const row = db.prepare("SELECT id FROM relationer WHERE id = ? AND treeId = ?").get(id, treeId);
  if (!row) return res.status(404).json({ error: "NOT_FOUND" });

  db.prepare("DELETE FROM relationer WHERE id = ? AND treeId = ?").run(id, treeId);
  return res.json({ ok: true });
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`DB: ${dbPath}`);
});

FILE: app/index.html
<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Släktträdet – Start</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; padding: 24px; max-width: 900px; }
    a { display: inline-block; margin-right: 12px; margin-top: 8px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>Släktträdet</h1>
  <p class="muted">Auth + Träd + Roller (RBAC per träd).</p>

  <a href="./register.html">Skapa konto</a>
  <a href="./login.html">Logga in</a>
  <a href="./me.html">Min profil</a>
</body>
</html>

FILE: app/register.html
<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Skapa konto</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; padding: 24px; max-width: 900px; }
    label { display:block; margin-top: 12px; font-weight: 700; }
    input, button { width: 100%; padding: 10px; margin-top: 6px; font-size: 1rem; }
    button { border: 1px solid #333; background: #fff; cursor: pointer; margin-top: 16px; }
    .muted { color: #555; }
    .error { color: #b00020; font-weight: 700; }
    .ok { font-weight: 800; }
    a { display:inline-block; margin-bottom: 14px; }
  </style>
</head>
<body>
  <a href="./index.html">← Tillbaka</a>
  <h1>Skapa konto</h1>

  <label for="displayName">Namn</label>
  <input id="displayName" placeholder="t.ex. Anders" />

  <label for="email">E-post</label>
  <input id="email" placeholder="t.ex. du@exempel.se" />

  <label for="password">Lösenord (minst 8 tecken)</label>
  <input id="password" type="password" />

  <button id="btn">Skapa konto</button>
  <p id="msg" class="muted" aria-live="polite"></p>

<script>
  const API = "http://localhost:3001";
  const btn = document.getElementById("btn");
  const msg = document.getElementById("msg");

  btn.addEventListener("click", async () => {
    msg.textContent = "";
    const displayName = document.getElementById("displayName").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    try {
      const res = await fetch(API + "/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ displayName, email, password })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        msg.innerHTML = "<span class='error'>Fel: " + (data.error || "UNKNOWN") + "</span>";
        return;
      }

      msg.innerHTML = "<span class='ok'>Klart.</span> Du är nu inloggad. Gå till <a href='./me.html'>Min profil</a>.";
    } catch {
      msg.innerHTML = "<span class='error'>Kunde inte nå backend (API).</span>";
    }
  });
</script>
</body>
</html>

FILE: app/login.html
<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Logga in</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; padding: 24px; max-width: 900px; }
    label { display:block; margin-top: 12px; font-weight: 700; }
    input, button { width: 100%; padding: 10px; margin-top: 6px; font-size: 1rem; }
    button { border: 1px solid #333; background: #fff; cursor: pointer; margin-top: 16px; }
    .muted { color: #555; }
    .error { color: #b00020; font-weight: 700; }
    .ok { font-weight: 800; }
    a { display:inline-block; margin-bottom: 14px; }
  </style>
</head>
<body>
  <a href="./index.html">← Tillbaka</a>
  <h1>Logga in</h1>

  <label for="email">E-post</label>
  <input id="email" placeholder="t.ex. du@exempel.se" />

  <label for="password">Lösenord</label>
  <input id="password" type="password" />

  <button id="btn">Logga in</button>
  <p id="msg" class="muted" aria-live="polite"></p>

<script>
  const API = "http://localhost:3001";
  const btn = document.getElementById("btn");
  const msg = document.getElementById("msg");

  btn.addEventListener("click", async () => {
    msg.textContent = "";
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    try {
      const res = await fetch(API + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        msg.innerHTML = "<span class='error'>Fel: " + (data.error || "UNKNOWN") + "</span>";
        return;
      }

      msg.innerHTML = "<span class='ok'>Inloggad.</span> Gå till <a href='./me.html'>Min profil</a>.";
    } catch {
      msg.innerHTML = "<span class='error'>Kunde inte nå backend (API).</span>";
    }
  });
</script>
</body>
</html>

FILE: app/me.html
<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Min profil</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; padding: 24px; max-width: 900px; }
    .muted { color: #555; }
    .error { color: #b00020; font-weight: 700; }
    .card { border:1px solid #ddd; border-radius:10px; padding:16px; margin-top: 14px; }
    button { padding: 10px 12px; border: 1px solid #333; background:#fff; cursor:pointer; margin-right: 8px; margin-top: 8px; }
    a { display:inline-block; margin-bottom: 14px; }
    pre { background:#f4f4f4; padding:12px; border-radius:10px; overflow:auto; }
  </style>
</head>
<body>
  <a href="./index.html">← Tillbaka</a>
  <h1>Min profil</h1>
  <p class="muted">Hämtar <code>/me</code> och visar JSON.</p>

  <div class="card">
    <button id="loadBtn">Hämta profil</button>
    <button id="logoutBtn">Logga ut</button>
    <p id="msg" class="muted" aria-live="polite"></p>
    <pre><code id="out">{}</code></pre>
  </div>

<script>
  const API = "http://localhost:3001";
  const out = document.getElementById("out");
  const msg = document.getElementById("msg");
  const loadBtn = document.getElementById("loadBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  function show(obj) {
    out.textContent = JSON.stringify(obj, null, 2);
  }

  loadBtn.addEventListener("click", async () => {
    msg.textContent = "";
    try {
      const res = await fetch(API + "/me", { credentials: "include" });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        msg.innerHTML = "<span class='error'>Inte inloggad.</span> Gå till <a href='./login.html'>Logga in</a>.";
        show(data);
        return;
      }

      msg.textContent = "OK.";
      show(data);
    } catch {
      msg.innerHTML = "<span class='error'>Kunde inte nå backend (API).</span>";
    }
  });

  logoutBtn.addEventListener("click", async () => {
    msg.textContent = "";
    try {
      const res = await fetch(API + "/auth/logout", { method: "POST", credentials: "include" });
      const data = await res.json().catch(() => ({}));
      msg.textContent = data.ok ? "Utloggad." : "Kunde inte logga ut.";
      show(data);
    } catch {
      msg.innerHTML = "<span class='error'>Kunde inte nå backend (API).</span>";
    }
  });
</script>
</body>
</html>
