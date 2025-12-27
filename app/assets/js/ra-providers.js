/* ============================================================
   ra-providers.js
   ------------------------------------------------------------
   Släktkort – Riksarkivet Providerlager (AO-API-03 PATCH v3.1)
   ------------------------------------------------------------
   Ansvar:
   - All extern datainhämtning (Riksarkivet m.fl.)
   - UI ska ALDRIG prata direkt med externa API:er
   - Fail-closed + demo-fallback (UI kan göra fallback)
   - Ingen persistent lagring av extern persondata
   ------------------------------------------------------------
   Används av:
   - person-search.html
   - person-puzzle.html
   ------------------------------------------------------------
   AO-API-03:
   - Max 150 kandidater (LÅST)
   - Stöd för RA Worker-format med { hits, items }
   - Exponerar enrichProviders (IIIF/OAI stubs)
   - Inga storage-keys, ingen datamodell ändras
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     KONFIGURATION (LÅST)
     ============================================================ */

  const PROXY_BASE = "https://slaktkort01234.andersmenyit.workers.dev";
  const FETCH_TIMEOUT = 8000;

  // AO-API-03: max 150 (LÅST)
  const MAX_LIMIT = 150;

  // Fail-closed: minimikrav för query (håll i sync med UI)
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
    // ex: "1661 - 1704" eller "1704"
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
    // RA brukar ha _links med olika nycklar. Vi försöker några vanliga.
    if (!links || typeof links !== "object") return "";

    const tryKeys = ["html", "self", "alternate", "record", "ui", "web"];
    for (const k of tryKeys) {
      const node = links[k];
      if (!node) continue;

      // node kan vara { href: "..." } eller array
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

    // sista chans: leta första href i objektet
    for (const key of Object.keys(links)) {
      const node = links[key];
      if (node && typeof node === "object" && node.href) {
        const u = safeUrl(node.href);
        if (u) return u;
      }
    }
    return "";
  }

  function makeTmpId() {
    // fail-soft: crypto.randomUUID om finns, annars tidsbaserat
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch {}
    return "tmp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  /* ============================================================
     CANDIDATE-FORMAT (LÅST KONTRAKT)
     ============================================================ */

  function makeCandidate(o) {
    return {
      id: String(o.id || ""),
      name: String(o.name || ""),
      birthYear: (typeof o.birthYear === "number" && Number.isFinite(o.birthYear)) ? o.birthYear : (o.birthYear ?? null),
      deathYear: (typeof o.deathYear === "number" && Number.isFinite(o.deathYear)) ? o.deathYear : (o.deathYear ?? null),
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
        .map(p =>
          makeCandidate({
            ...p,
            source: "Demo",
            why: ["Demo-post"]
          })
        );
    }
  };

  /* ============================================================
     RIKSARKIVET – VIA WORKER (SearchApiProvider)
     - payload exempel:
       {
         totalHits: 17219,
         hits: 5,
         offset: 0,
         items: [ ... ]
       }
     ============================================================ */

  const SearchApiProvider = {
    id: "searchapi",
    label: "Riksarkivet (via proxy)",

    async search(query) {
      const q = String(query || "").trim();
      if (q.length < MIN_QUERY_LEN) return [];

      // LÅST: alltid max 150
      const limit = MAX_LIMIT;

      // UI ska inte skicka '+', men om det händer: fail-closed mild
      // (vi ersätter + med mellanslag, så "Erik+Leksand" inte blir “exakt sträng” mot RA)
      const qSan = q.replace(/\+/g, " ").replace(/\s+/g, " ").trim();

      const url = PROXY_BASE + "/records?name=" + encodeURIComponent(qSan) + "&limit=" + String(limit);

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

      // ✅ Viktigt: items är listan (fail-closed om formatet är fel)
      const rawItems = (json && (json.items ?? json.records ?? json.data ?? json.results)) ?? [];
      if (!Array.isArray(rawItems)) {
        throw new Error("BAD_PAYLOAD");
      }

      if (!rawItems.length) return [];

      return rawItems.slice(0, limit).map((r) => {
        const id = pickText(r && (r.id || r.identifier)) || makeTmpId();

        const name =
          pickText(r && (r.caption || r.name || r.title || r.label)) ||
          pickText(r && r.metadata && r.metadata.title) ||
          "(namn saknas)";

        // datum/år ligger ofta i metadata.date
        const mdDate = (r && r.metadata) ? r.metadata.date : "";
        const years = parseDateRangeFromMetadataDate(mdDate);

        // plats: ofta inte stabilt → lämna tomt om oklar
        const place =
          pickText(r && (r.place || r.location)) ||
          pickText(r && r.metadata && (r.metadata.place || r.metadata.location || r.metadata.ort)) ||
          "";

        // url: försök från _links / links
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
            "Match via namn",
            mdDate ? ("Datum: " + pickText(mdDate)) : ""
          ].filter(Boolean)
        });
      });
    }
  };

  /* ============================================================
     ENRICH PROVIDERS (AO-API-03)
     - stubs: metadata/länkar endast (ingen lagring)
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
    // auto: försök searchapi först, annars demo
    return (SearchApiProvider && typeof SearchApiProvider.search === "function") ? SearchApiProvider : DemoProvider;
  }

  window.RAProviders = {
    listProviders,
    pickProvider,
    enrichProviders
  };
})();
