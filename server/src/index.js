app.post("/trees", authGuard, (req, res) => {
  ...
});
// =====================================================
// SLÄKTKORT (tree-scoped data)
// -----------------------------------------------------
// Viktiga principer:
// - Släktkort är DATA, inte användarkonton
// - Alla släktkort tillhör exakt ett träd (treeId)
// - Åtkomst styrs via medlemskap i trädet
// =====================================================


// -----------------------------------------------------
// Hjälpfunktion: kontrollera att användaren är medlem
// i ett träd och hämta rollen (OWNER / EDITOR / VIEWER)
// -----------------------------------------------------
function ensureTreeMemberRole(db, userId, treeId) {
  try {
    const row = db.prepare(
      "SELECT role FROM tree_members WHERE userId = ? AND treeId = ?"
    ).get(userId, treeId);

    // returnerar t.ex. "OWNER", "EDITOR", "VIEWER" eller null
    return row?.role || null;
  } catch {
    // Vid DB-fel: behandla som ingen åtkomst
    return null;
  }
}


// -----------------------------------------------------
// GET /trees/:treeId/slaktkort
// Hämtar alla släktkort i ett träd
// -----------------------------------------------------
app.get("/trees/:treeId/slaktkort", authGuard, (req, res) => {
  const treeId = String(req.params.treeId || "").trim();
  if (!treeId) {
    return res.status(400).json({ error: "INVALID_TREE_ID" });
  }

  // Kräver att användaren är medlem i trädet
  const role = ensureTreeMemberRole(db, req.user.id, treeId);
  if (!role) {
    return res.status(403).json({ error: "FORBIDDEN" });
  }

  try {
    const rows = db.prepare(`
      SELECT
        id,
        fornamn,
        efternamn,
        kon,
        fodelsear,
        dodsar,
        plats,
        lat,
        lon,
        anteckning,
        createdAt
      FROM slaktkort
      WHERE treeId = ?
      ORDER BY createdAt DESC
    `).all(treeId);

    return res.json({ slaktkort: rows });
  } catch {
    return res.status(500).json({ error: "SLÄKTKORT_LIST_FAILED" });
  }
});


// -----------------------------------------------------
// POST /trees/:treeId/slaktkort
// Skapar ett nytt släktkort i ett träd
// -----------------------------------------------------
app.post("/trees/:treeId/slaktkort", authGuard, (req, res) => {
  const treeId = String(req.params.treeId || "").trim();
  if (!treeId) {
    return res.status(400).json({ error: "INVALID_TREE_ID" });
  }

  // Kräver minst EDITOR (OWNER är också OK)
  const role = ensureTreeMemberRole(db, req.user.id, treeId);
  if (!role) {
    return res.status(403).json({ error: "FORBIDDEN" });
  }
  if (!["OWNER", "EDITOR"].includes(role)) {
    return res.status(403).json({ error: "INSUFFICIENT_ROLE" });
  }

  // -------- Läs in grunddata --------
  const fornamn = String(req.body?.fornamn || "").trim();
  const efternamn = String(req.body?.efternamn || "").trim();
  const kon = String(req.body?.kon || "Okänt").trim();

  if (!fornamn || !efternamn) {
    return res.status(400).json({ error: "NAME_REQUIRED" });
  }

  // -------- Årtal (valfria) --------
  const fodelsearRaw = req.body?.fodelsear;
  const dodsarRaw = req.body?.dodsar;

  const fodelsear =
    fodelsearRaw === null || fodelsearRaw === undefined || fodelsearRaw === ""
      ? null
      : Number(fodelsearRaw);

  const dodsar =
    dodsarRaw === null || dodsarRaw === undefined || dodsarRaw === ""
      ? null
      : Number(dodsarRaw);

  if (fodelsear !== null && !Number.isInteger(fodelsear)) {
    return res.status(400).json({ error: "INVALID_FODELSEAR" });
  }
  if (dodsar !== null && !Number.isInteger(dodsar)) {
    return res.status(400).json({ error: "INVALID_DODSAR" });
  }

  // -------- Platsinformation --------
  // plats = fri text (mänsklig tolkning)
  // lat/lon = maskinell position (karta)
  const plats = String(req.body?.plats || "").trim();

  const lat =
    req.body?.lat === null || req.body?.lat === undefined
      ? null
      : Number(req.body.lat);

  const lon =
    req.body?.lon === null || req.body?.lon === undefined
      ? null
      : Number(req.body.lon);

  function numOrNull(n) {
    if (n === null) return null;
    if (!Number.isFinite(n)) return "__INVALID__";
    return n;
  }

  const la = numOrNull(lat);
  const lo = numOrNull(lon);

  if (la === "__INVALID__" || lo === "__INVALID__") {
    return res.status(400).json({ error: "INVALID_COORDS" });
  }

  const anteckning = String(req.body?.anteckning || "").trim();

  // -------- Skapa och spara --------
  const id = "p" + Date.now().toString().slice(-10);
  const createdAt = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO slaktkort (
        id,
        treeId,
        fornamn,
        efternamn,
        kon,
        fodelsear,
        dodsar,
        plats,
        lat,
        lon,
        anteckning,
        createdAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      treeId,
      fornamn,
      efternamn,
      kon,
      fodelsear,
      dodsar,
      plats || null,
      la,
      lo,
      anteckning || null,
      createdAt
    );

    // Returnera det skapade släktkortet
    const row = db.prepare(`
      SELECT
        id,
        fornamn,
        efternamn,
        kon,
        fodelsear,
        dodsar,
        plats,
        lat,
        lon,
        anteckning,
        createdAt
      FROM slaktkort
      WHERE id = ?
    `).get(id);

    return res.status(201).json({ slaktkort: row });
  } catch {
    return res.status(500).json({ error: "SLÄKTKORT_CREATE_FAILED" });
  }
});
Add documented backend routes for släktkort scoped to tree,
including role checks and lat/lon support.
