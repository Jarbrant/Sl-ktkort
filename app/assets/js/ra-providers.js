/* ============================================================
   ra-providers.js
   ------------------------------------------------------------
   Släktkort – Riksarkivet Providerlager (AO-API-03 PATCH v4)
   ------------------------------------------------------------
   Ansvar:
   - All extern datainhämtning (Riksarkivet m.fl.)
   - UI ska ALDRIG prata direkt med externa API:er
   - Fail-closed + demo-fallback
   - Ingen persistent lagring av extern persondata
   ------------------------------------------------------------
   Används av:
   - person-search.html
   - person-puzzle.html
   ------------------------------------------------------------
   AO-API-03:
   - Limit = 150
   - Stöd för RA Worker-format: { totalHits, hits, offset, items: [...] }
   - Filtrerar bort icke-personer (byggnader, ritningar, recordsets)
   - Exponerar window.RAProviders.enrichProviders (IIIF/OAI stubs)
   - Inga nya storage-keys, ingen datamodell ändras
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

  // ----- Person-filter (viktigast) -----
  function isPersonItem(r) {
    // Riksarkivet /records kan ge Record, RecordSet, Agent, Place osv.
    // Vi vill i första hand: objectType=Agent och type=Person.
    const ot = pickText(r && r.objectType);
    const tp = pickText(r && r.type);

    const otN = normalize(ot);
    const tpN = normalize(tp);

    if (otN === "agent" && tpN === "person") return true;

    // Fail-soft: vissa svar kan ha "Person" på annan plats.
    // (Vi tillåter bara om både "agent" och "person" syns tydligt.)
    if (otN === "agent" && tpN.includes("person")) return true;

    return false;
  }

  function looksLikePersonName(s) {
    // Extra skydd: vi vill inte råka ta in titlar.
    // Vanligt personformat i RA: "Efternamn, Förnamn"
    const t = String(s || "").trim();
    if (!t) return false;
    if (t.length < 3) return false;

    // Om det innehåller komma är det ofta namn i RA
    if (t.includes(",")) return true;

    // Annars kräver vi minst två ord och ingen tydlig byggnad/ritning-känsla
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return false;

    // Litet stopp-ord-filter (fail-closed hellre för få än fel)
    const bad = ["kapell", "kyrka", "skiss", "fasad", "plan", "byggnad", "kyrkvallen"];
    const low = normalize(t);
    if (bad.some(w => low.includes(w))) return false;

    return true;
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
      if (q.length < 2) return [];
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
     RIKSARKIVET – VIA WORKER
     ============================================================ */

  const SearchApiProvider = {
    id: "searchapi",
    label: "Riksarkivet (via proxy)",

    async search(query) {
      const q = String(query || "").trim();
      if (q.length < 2) return [];

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
      const rawItems = safeArray(json.items || json.records || json.data || json.results || []);
      if (!rawItems.length) return [];

      // 1) Filtrera till Person
      const personItems = rawItems.filter(isPersonItem);

      // Fail-closed: om API ändrat format så kan detta bli tomt (hellre 0 än fel typ)
      if (!personItems.length) return [];

      // 2) Mappa till Candidate
      const out = [];
      for (const r of personItems.slice(0, limit)) {
        const id =
          pickText(r.id || r.identifier) ||
          ((typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : ("tmp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)));

        // Personnamn i RA brukar ligga i caption
        const caption = pickText(r.caption || r.name || r.title || r.label || (r.metadata && r.metadata.title));
        if (!looksLikePersonName(caption)) {
          // extra skydd: hoppa över om det inte ser ut som personnamn
          continue;
        }

        const mdDate = r && r.metadata ? r.metadata.date : "";
        const years = parseDateRangeFromMetadataDate(mdDate);

        // plats saknas ofta i Agent-träffar -> tomt (fail-closed)
        const place = pickText(r.place || r.location || (r.metadata && (r.metadata.place || r.metadata.location || r.metadata.ort))) || "";

        const urlOut = extractUrlFromLinks(r && (r._links || r.links)) || "";

        out.push(
          makeCandidate({
            id,
            name: caption,
            birthYear: years.birthYear,
            deathYear: years.deathYear,
            place,
            source: "Riksarkivet",
            url: urlOut,
            why: [
              "Match via namn (Person)",
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
