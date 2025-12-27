/* ============================================================
   ra-providers.js
   ------------------------------------------------------------
   Släktkort – Riksarkivet Providerlager (AO-API-03 PATCH v4.1)
   ------------------------------------------------------------
   Ansvar:
   - All extern datainhämtning (Riksarkivet m.fl.)
   - UI ska ALDRIG prata direkt med externa API:er
   - Fail-closed + demo-fallback
   - Ingen persistent lagring av extern persondata
   ------------------------------------------------------------
   AO-API-03:
   - Limit = 150 (max 150)
   - Stöd för RA Worker-format: { totalHits, hits, offset, items: [...] }
   - Filtrerar bort icke-personer (byggnader, ritningar, recordsets)
   - Exponerar window.RAProviders.enrichProviders (IIIF/OAI stubs)
   - Inga nya storage-keys, ingen datamodell ändras
   ------------------------------------------------------------
   Viktig princip:
   - Hellre 0 träffar än fel typ (fail-closed)
   - Men vi gör person-detektionen robust så att “riktiga personer” inte faller bort
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     KONFIGURATION (LÅST)
     ============================================================ */
  const PROXY_BASE = "https://slaktkort01234.andersmenyit.workers.dev";
  const FETCH_TIMEOUT = 8000;

  const DEFAULT_LIMIT = 150;
  const MAX_LIMIT = 150;
  const MIN_QUERY_LEN = 3;

  /* ============================================================
     HJÄLPFUNKTIONER
     ============================================================ */

  function abortableFetch(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  function normalize(s) {
    return String(s || "").trim().toLowerCase();
  }

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), min), max);
  }

  function safeUrl(s) {
    const u = String(s || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) return "";
    return u;
  }

  function pickText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(pickText).filter(Boolean).join(" ").trim();
    if (typeof v === "object") {
      return pickText(
        v.text ?? v.value ?? v.label ?? v.title ?? v.name ?? v.caption ?? v.displayName ?? v.content ?? ""
      );
    }
    return String(v);
  }

  function makeTmpId() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch {}
    return "tmp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function parseDateRangeFromMetadataDate(dateStr) {
    const s = pickText(dateStr);
    if (!s) return { birthYear: null, deathYear: null };

    const years = s.match(/\b(1[0-9]{3}|20[0-9]{2})\b/g) || [];
    const a = years.length >= 1 ? Number(years[0]) : null;
    const b = years.length >= 2 ? Number(years[1]) : null;

    return {
      birthYear: Number.isFinite(a) ? a : null,
      deathYear: Number.isFinite(b) ? b : null
    };
  }

  function extractUrlFromLinks(links) {
    if (!links || typeof links !== "object") return "";

    const tryKeys = ["html", "self", "alternate", "record", "ui", "web"];
    for (const k of tryKeys) {
      const node = links[k];
      if (!node) continue;

      if (typeof node === "object" && node.href) {
        const u = safeUrl(node.href);
        if (u) return u;
      }
      if (Array.isArray(node)) {
        for (const it of node) {
          const u = safeUrl(it && it.href);
          if (u) return u;
        }
      }
    }

    for (const key of Object.keys(links)) {
      const node = links[key];
      if (node && typeof node === "object" && node.href) {
        const u = safeUrl(node.href);
        if (u) return u;
      }
    }
    return "";
  }

  /* ============================================================
     PERSON-FILTER (ROBUST, men fail-closed)
     ============================================================ */

  // Negativa signaler (vill aldrig släppa igenom)
  const NEGATIVE_TYPE_TOKENS = [
    "recordset", "record set", "record", "arkiv", "series",
    "place", "ort", "socken",
    "building", "byggnad",
    "drawing", "ritning", "skiss", "fasad", "plan",
    "map", "karta",
    "photograph", "foto", "bild"
  ];

  function collectTypeTokens(r) {
    // Samla alla typfält vi kan hitta (RA kan variera)
    const bag = [];

    // direkta typfält
    bag.push(r && r.objectType);
    bag.push(r && r.type);
    bag.push(r && r["@type"]);
    bag.push(r && r.recordType);
    bag.push(r && r.entityType);
    bag.push(r && r.kind);
    bag.push(r && r.class);

    // metadata
    bag.push(r && r.metadata && (r.metadata.objectType || r.metadata.type || r.metadata["@type"] || r.metadata.entityType || r.metadata.recordType));

    // ibland ligger "type" i _links/rel eller liknande (sällsynt) – vi ignorerar för säkerhet

    const merged = bag
      .flatMap(v => Array.isArray(v) ? v : [v])
      .map(v => normalize(pickText(v)))
      .filter(Boolean);

    // dedupe
    return Array.from(new Set(merged));
  }

  function hasNegativeType(typeTokens) {
    if (!typeTokens.length) return false;
    return typeTokens.some(t => NEGATIVE_TYPE_TOKENS.some(bad => t.includes(bad)));
  }

  function isLikelyPersonItem(r) {
    // Fail-closed: utan tydlig person-signal släpper vi inte igenom
    const typeTokens = collectTypeTokens(r);

    // Om vi tydligt ser att det är fel typ -> blockera
    if (hasNegativeType(typeTokens)) return false;

    // Positiva signaler: “agent” + “person” någonstans
    const joined = typeTokens.join(" | ");
    const hasAgent = joined.includes("agent");
    const hasPerson = joined.includes("person");

    // Klassisk “objectType=Agent + type=Person”
    const ot = normalize(pickText(r && r.objectType));
    const tp = normalize(pickText(r && r.type));
    if (ot === "agent" && (tp === "person" || tp.includes("person"))) return true;

    // Robust fallback: om typeTokens innehåller både agent och person
    if (hasAgent && hasPerson) return true;

    return false;
  }

  function extractBestPersonName(r) {
    // Prioritera fält som typiskt är personnamn (undvik title/caption om det är arkiv-titel)
    const candidates = [
      r && r.displayName,
      r && r.name,
      r && r.personName,
      r && r.agentName,
      r && r.metadata && (r.metadata.name || r.metadata.personName || r.metadata.agentName || r.metadata.displayName),
      // fallback
      r && r.caption,
      r && r.title,
      r && r.label,
      r && r.metadata && r.metadata.title
    ];

    return String(pickText(candidates.filter(Boolean)) || "").trim();
  }

  function looksLikePersonName(s) {
    // Fail-closed men inte onödigt hård: vi vill hellre släppa namn än byggnadstitlar
    const t = String(s || "").trim();
    if (!t) return false;
    if (t.length < 2) return false;
    if (t.length > 80) return false;

    // Måste innehålla bokstäver
    if (!/[A-Za-zÅÄÖåäö]/.test(t)) return false;

    // Typiska arkiv/byggnadstitlar har ofta kolon
    if (t.includes(":")) return false;

    // Stopplista på uppenbara bygg/ritningsord (sv + en)
    const low = normalize(t);
    const badWords = [
      "kapell", "kyrka", "kyrkogård", "församling",
      "ritning", "skiss", "fasad", "plan", "byggnad",
      "s:t", "st.", // ofta i bygg/platstitlar
      "inventering", "förteckning", "serie", "volym"
    ];
    if (badWords.some(w => low.includes(w))) return false;

    // RA-personer kommer ofta som "Efternamn, Förnamn"
    if (t.includes(",")) return true;

    // Annars tillåt 1–3 ord (Larsson / Anna Maria / Per Olof Larsson)
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length >= 1 && parts.length <= 4) return true;

    return false;
  }

  /* ============================================================
     CANDIDATE-FORMAT (LÅST KONTRAKT)
     ============================================================ */
  function makeCandidate(o) {
    return {
      id: String(o.id || ""),
      name: String(o.name || ""),
      birthYear: o.birthYear ?? null,
      deathYear: o.deathYear ?? null,
      place: String(o.place || ""),
      source: String(o.source || ""),
      url: safeUrl(o.url || ""),
      why: safeArray(o.why).map(String)
    };
  }

  /* ============================================================
     DEMO PROVIDER
     ============================================================ */
  const DEMO_DATA = [
    { id: "d1", name: "Karl Johansson", birthYear: 1872, deathYear: 1939, place: "Falun" },
    { id: "d2", name: "Anna Persdotter", birthYear: 1878, deathYear: 1951, place: "Leksand" },
    { id: "d3", name: "Erik Lind", birthYear: 1901, deathYear: 1977, place: "Gävle" },
    { id: "d4", name: "Maria Nilsdotter", birthYear: 1822, deathYear: 1890, place: "Uppsala" }
  ];

  const DemoProvider = {
    id: "demo",
    label: "Demo (offline)",
    async search(query) {
      const q = normalize(query);
      if (q.length < MIN_QUERY_LEN) return [];
      return DEMO_DATA
        .filter(p => normalize(p.name).includes(q) || normalize(p.place).includes(q))
        .slice(0, MAX_LIMIT)
        .map(p => makeCandidate({ ...p, source: "Demo", why: ["Demo-post"] }));
    }
  };

  /* ============================================================
     RIKSARKIVET – VIA WORKER
     ============================================================ */
  const SearchApiProvider = {
    id: "searchapi",
    label: "Riksarkivet (via proxy)",

    async search(query) {
      const qRaw = String(query || "").trim();
      if (qRaw.length < MIN_QUERY_LEN) return [];

      // Säker sanering: om '+' ändå kommer in -> ersätt med mellanslag
      const q = qRaw.replace(/\+/g, " ").replace(/\s+/g, " ").trim();

      const limit = clampInt(DEFAULT_LIMIT, 1, MAX_LIMIT, DEFAULT_LIMIT);
      const url = PROXY_BASE + "/records?name=" + encodeURIComponent(q) + "&limit=" + String(limit);

      let res;
      try {
        res = await abortableFetch(url);
      } catch {
        throw new Error("NETWORK_OR_TIMEOUT");
      }

      if (!res.ok) {
        throw new Error("UPSTREAM_HTTP_" + res.status);
      }

      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error("BAD_JSON");
      }

      // RA worker-format: items är listan
      const rawItems = (json && (json.items || json.records || json.data || json.results)) || [];
      if (!Array.isArray(rawItems) || rawItems.length === 0) return [];

      // 1) Filtrera till sannolika PERSON-items
      const personItems = rawItems.filter(isLikelyPersonItem);
      if (!personItems.length) return []; // fail-closed

      // 2) Mappa till Candidate
      const out = [];
      for (const r of personItems) {
        if (out.length >= limit) break;

        const id = pickText(r && (r.id || r.identifier)) || makeTmpId();

        const name = extractBestPersonName(r);
        if (!looksLikePersonName(name)) continue; // extra skydd

        const mdDate = r && r.metadata ? r.metadata.date : "";
        const years = parseDateRangeFromMetadataDate(mdDate);

        // plats saknas ofta i Agent-träffar -> tomt (fail-closed)
        const place = pickText(
          (r && (r.place || r.location)) ||
          (r && r.metadata && (r.metadata.place || r.metadata.location || r.metadata.ort)) ||
          ""
        ) || "";

        const urlOut = extractUrlFromLinks(r && (r._links || r.links)) || "";

        out.push(
          makeCandidate({
            id,
            name,
            birthYear: years.birthYear,
            deathYear: years.deathYear,
            place,
            source: "Riksarkivet",
            url: urlOut,
            why: [
              "Match via namn (Person/Agent)",
              mdDate ? ("Datum: " + pickText(mdDate)) : ""
            ].filter(Boolean)
          })
        );
      }

      return out.slice(0, limit);
    }
  };

  /* ============================================================
     ENRICH PROVIDERS (AO-API-03) – stubs
     ============================================================ */
  const enrichProviders = [
    {
      id: "iiif_stub",
      label: "IIIF (stub)",
      supports(candidate) {
        return Boolean(candidate && safeUrl(candidate.url));
      },
      async enrich(candidate) {
        try {
          const u = safeUrl(candidate.url);
          if (!u) return [];
          return [
            {
              providerId: "iiif_stub",
              type: "iiif",
              title: "IIIF (stub) – metadata/länk",
              confidence: 0.35,
              fields: { note: "stub" },
              url: u
            }
          ];
        } catch {
          return [];
        }
      }
    },
    {
      id: "oai_stub",
      label: "OAI-PMH (stub)",
      supports(candidate) {
        return Boolean(candidate && String(candidate.id || "").trim());
      },
      async enrich() {
        return [];
      }
    }
  ];

  /* ============================================================
     PROVIDER-REGISTRY
     ============================================================ */
  const REGISTRY = new Map();
  REGISTRY.set(DemoProvider.id, DemoProvider);
  REGISTRY.set(SearchApiProvider.id, SearchApiProvider);

  /* ============================================================
     PUBLIKT API (window.RAProviders)
     ============================================================ */
  function listProviders() {
    return Array.from(REGISTRY.values()).map(p => ({ id: p.id, label: p.label }));
  }

  function pickProvider(preferred = "auto") {
    if (preferred === "demo") return DemoProvider;
    if (preferred === "searchapi") return SearchApiProvider;
    return SearchApiProvider || DemoProvider;
  }

  window.RAProviders = {
    listProviders,
    pickProvider,
    enrichProviders
  };
})();
