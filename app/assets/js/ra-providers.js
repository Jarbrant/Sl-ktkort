/* ============================================================
   ra-providers.js
   ------------------------------------------------------------
   Släktkort – Riksarkivet Providerlager (AO-API-03 FINAL)
   ------------------------------------------------------------
   Ansvar:
   - All extern datainhämtning (Riksarkivet m.fl.)
   - UI ska ALDRIG prata direkt med externa API:er
   - Fail-closed + demo-fallback
   - Ingen persistent lagring av extern persondata
   ------------------------------------------------------------
   Används av:
   - app/person-search.html
   - app/person-puzzle.html
   ------------------------------------------------------------
   AO-API-03:
   - Max 150 resultat
   - Använder Worker endpoint /persons för person-filter
   - Tolkar RA Worker-format: { totalHits, hits, offset, items: [] }
   - Exponerar window.RAProviders.enrichProviders (IIIF/OAI stubs)
   - Inga nya storage-keys, ingen datamodell ändras
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     KONFIGURATION (LÅST)
     ============================================================ */

  // ✅ Cloudflare Worker (CORS-brygga)
  const PROXY_BASE = "https://slaktkort01234.andersmenyit.workers.dev";

  // Timeout för nätverksanrop (ms)
  const FETCH_TIMEOUT = 9000;

  // AO-API-03: max 150
  const DEFAULT_LIMIT = 150;
  const MAX_LIMIT = 150;

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
    const i = Math.trunc(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
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

  function parseDateRangeFromMetadataDate(dateStr) {
    // ex: "1661 - 1704" eller "1704" etc
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

  function newTmpId() {
    return "tmp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
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
     DEMO PROVIDER (ALLTID TILLGÄNGLIG)
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
      if (q.length < 2) return [];
      return DEMO_DATA
        .filter(p => normalize(p.name).includes(q) || normalize(p.place).includes(q))
        .map(p => makeCandidate({ ...p, source: "Demo", why: ["Demo-post"] }));
    }
  };

  /* ============================================================
     RIKSARKIVET – PERSONS (via Worker)
     - Använder /persons för att filtrera till Person/Agent.
     - Förväntat payload-format:
       { totalHits: number, hits: number, offset: number, items: [...] }
     ============================================================ */

  const PersonsProvider = {
    id: "persons",
    label: "Riksarkivet Personer (via proxy)",

    async search(query) {
      const q = String(query || "").trim();
      if (q.length < 2) return [];

      const limit = clampInt(DEFAULT_LIMIT, 1, MAX_LIMIT, DEFAULT_LIMIT);

      // ✅ Viktigt: använd /persons här (inte /records)
      const url =
        PROXY_BASE +
        "/persons?name=" + encodeURIComponent(q) +
        "&limit=" + String(limit);

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

      // ✅ items är listan (som i din output)
      const items = safeArray(json.items || json.records || json.data || json.results || []);
      if (!items.length) return [];

      return items.slice(0, limit).map((r) => {
        const id =
          pickText(r.id || r.identifier) ||
          ((typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : newTmpId());

        // ✅ caption brukar vara bäst (ex: "Odhelius, Erich")
        const name =
          pickText(r.caption || r.name || r.title || r.label || (r.metadata && r.metadata.title)) ||
          "(namn saknas)";

        // ✅ år ligger ofta i metadata.date: "1661 - 1704"
        const mdDate = r && r.metadata ? r.metadata.date : "";
        const years = parseDateRangeFromMetadataDate(mdDate);

        // Plats saknas ofta i detta dataset (fail-closed)
        const place =
          pickText(r.place || r.location || (r.metadata && (r.metadata.place || r.metadata.location || r.metadata.ort))) ||
          "";

        // URL: försök från _links/links
        const urlOut = extractUrlFromLinks(r && (r._links || r.links)) || "";

        return makeCandidate({
          id,
          name,
          birthYear: years.birthYear,
          deathYear: years.deathYear,
          place,
          source: "Riksarkivet",
          url: urlOut,
          why: [
            "Person-filter (/persons)",
            mdDate ? ("Datum: " + pickText(mdDate)) : ""
          ].filter(Boolean)
        });
      });
    }
  };

  /* ============================================================
     (Valfritt) Generell records-provider (behåll för framtida AO)
     - Inte använd av person-search om ni pickProvider("auto") -> persons.
     ============================================================ */

  const RecordsProvider = {
    id: "records",
    label: "Riksarkivet (alla typer) via proxy",
    async search(query) {
      const q = String(query || "").trim();
      if (q.length < 2) return [];

      const limit = clampInt(DEFAULT_LIMIT, 1, MAX_LIMIT, DEFAULT_LIMIT);
      const url =
        PROXY_BASE +
        "/records?name=" + encodeURIComponent(q) +
        "&limit=" + String(limit);

      let res;
      try {
        res = await abortableFetch(url);
      } catch {
        throw new Error("NETWORK_OR_TIMEOUT");
      }

      if (!res.ok) throw new Error("UPSTREAM_HTTP_" + res.status);

      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error("BAD_JSON");
      }

      const items = safeArray(json.items || json.records || json.data || json.results || []);
      if (!items.length) return [];

      return items.slice(0, limit).map((r) => {
        const id = pickText(r.id || r.identifier) || newTmpId();
        const name =
          pickText(r.caption || r.name || r.title || r.label || (r.metadata && r.metadata.title)) ||
          "(namn saknas)";
        const mdDate = r && r.metadata ? r.metadata.date : "";
        const years = parseDateRangeFromMetadataDate(mdDate);
        const place = pickText(r.place || r.location) || "";
        const urlOut = extractUrlFromLinks(r && (r._links || r.links)) || "";
        return makeCandidate({
          id,
          name,
          birthYear: years.birthYear,
          deathYear: years.deathYear,
          place,
          source: "Riksarkivet (records)",
          url: urlOut,
          why: ["Match via namn (records)"].filter(Boolean)
        });
      });
    }
  };

  /* ============================================================
     ENRICH PROVIDERS (AO-API-03)
     - stubs: metadata/länkar endast
     ============================================================ */

  const enrichProviders = [
    {
      id: "iiif_stub",
      label: "IIIF (stub)",
      supports(candidate) {
        return Boolean(candidate && safeUrl(candidate.url));
      },
      async enrich(candidate /*, hints */) {
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

  // Auto ska prioritera persons-filter först (för att slippa byggnader osv)
  REGISTRY.set(PersonsProvider.id, PersonsProvider);

  // Records finns kvar för framtid/utbyggnad
  REGISTRY.set(RecordsProvider.id, RecordsProvider);

  /* ============================================================
     PUBLIKT API (window.RAProviders)
     ============================================================ */

  function listProviders() {
    return Array.from(REGISTRY.values()).map(p => ({ id: p.id, label: p.label }));
  }

  function pickProvider(preferred = "auto") {
    if (preferred === "demo") return DemoProvider;
    if (preferred === "persons") return PersonsProvider;
    if (preferred === "records") return RecordsProvider;

    // auto: persons först, annars demo
    return PersonsProvider || DemoProvider;
  }

  window.RAProviders = {
    listProviders,
    pickProvider,
    enrichProviders
  };
})();
