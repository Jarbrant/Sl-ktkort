/* ============================================================
   ra-providers.js
   ------------------------------------------------------------
   Släktkort – Riksarkivet Providerlager (AO-API-01)
   + AO-API-03: Enrich Providers (IIIF/OAI stubs) för person-puzzle
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
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     KONFIGURATION (LÅST)
     ============================================================ */

  // ✅ Din fungerande Cloudflare Worker (CORS-brygga)
  const PROXY_BASE = "https://slaktkort01234.andersmenyit.workers.dev";

  // Timeout för nätverksanrop (ms)
  const FETCH_TIMEOUT = 8000;

  // Resultatgränser
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;

  /* ============================================================
     HJÄLPFUNKTIONER
     ============================================================ */

  function abortableFetch(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    return fetch(url, { signal: controller.signal })
      .finally(() => clearTimeout(timer));
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

  function clamp01(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function safeUUID() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch {}
    return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now();
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
      url: String(o.url || ""),
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
    { id: "d4", name: "Maria Nilsdotter", birthYear: 1822, deathYear: 1890, place: "Uppsala" },
  ];

  const DemoProvider = {
    id: "demo",
    label: "Demo (offline)",
    async search(query) {
      const q = normalize(query);
      if (q.length < 2) return [];
      return DEMO_DATA
        .filter(p =>
          normalize(p.name).includes(q) ||
          normalize(p.place).includes(q)
        )
        .map(p => makeCandidate({
          ...p,
          source: "Demo",
          why: ["Demo-post"]
        }));
    }
  };

  /* ============================================================
     RIKSARKIVET – SÖK-API VIA CLOUDFLARE WORKER
     ============================================================ */

  const SearchApiProvider = {
    id: "searchapi",
    label: "Riksarkivet (via proxy)",

    async search(query) {
      const q = String(query || "").trim();
      if (q.length < 2) return [];

      const limit = clampInt(DEFAULT_LIMIT, 1, MAX_LIMIT, DEFAULT_LIMIT);
      const url =
        PROXY_BASE +
        "/records?name=" + encodeURIComponent(q) +
        "&limit=" + limit;

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

      const records = safeArray(json.records || json.items || []);

      return records.map(r => makeCandidate({
        id: r.id || r.identifier || safeUUID(),
        name: r.name || r.title || r.label || "(namn saknas)",
        birthYear: Number.isFinite(+r.birthYear) ? +r.birthYear : null,
        deathYear: Number.isFinite(+r.deathYear) ? +r.deathYear : null,
        place: r.place || r.location || "",
        source: "Riksarkivet",
        url: r.url || r.uri || "",
        why: ["Match via namn"]
      }));
    }
  };

  /* ============================================================
     AO-API-03: ENRICH PROVIDERS (IIIF/OAI stubs)
     ------------------------------------------------------------
     VIKTIGT (LÅST):
     - Returnerar metadata/länkar endast (ingen bildrendering)
     - Fail-closed: fel => []
     - Ingen storage
     - UI (person-puzzle) förväntar sig:
       window.RAProviders.enrichProviders = [{id,supports,enrich}, ...]
     ============================================================ */

  function baseCandidateOk(c) {
    const n = normalize(c && c.name);
    if (!n) return false;
    if (n.replace(/\s+/g, "").length < 3) return false;
    // url/id hjälper men krävs inte
    return true;
  }

  function makeBit(providerId, type, title, confidence, url, fields) {
    return {
      providerId: String(providerId || ""),
      type: String(type || "note"),
      title: String(title || ""),
      confidence: clamp01(confidence),
      url: String(url || ""),
      fields: (fields && typeof fields === "object") ? fields : {}
    };
  }

  // IIIF stub:
  // - Om candidate.url redan ser ut som iiif/manifest -> returnera länk
  // - Annars (om recordId finns) prova proxy: /iiif?recordId=
  const EnrichIIIF = {
    id: "enrich-iiif-01",
    supports(candidate) {
      return baseCandidateOk(candidate);
    },
    async enrich(candidate /*, hints */) {
      const bits = [];
      const cUrl = String(candidate && candidate.url ? candidate.url : "");
      const cId  = String(candidate && candidate.id ? candidate.id : "");

      try {
        const looksIiif = /iiif/i.test(cUrl) || /manifest/i.test(cUrl);
        if (cUrl && looksIiif) {
          bits.push(makeBit(
            "enrich-iiif-01",
            "iiif",
            "IIIF (manifest-länk)",
            0.8,
            cUrl,
            { note: "Länk från kandidat (heuristik).", recordId: cId || "" }
          ));
          return bits;
        }

        // Valfri proxy endpoint: /iiif?recordId=<id>
        if (!cId) return bits;

        const probeUrl = PROXY_BASE + "/iiif?recordId=" + encodeURIComponent(cId);
        const res = await abortableFetch(probeUrl);
        if (!res.ok) return bits;

        const json = await res.json().catch(() => null);
        const manifest = json && (json.manifest || json.url || json.iiifManifest);
        if (!manifest) return bits;

        bits.push(makeBit(
          "enrich-iiif-01",
          "iiif",
          "IIIF (manifest-länk)",
          0.75,
          String(manifest),
          { note: "Hämtad via proxy.", recordId: cId }
        ));
        return bits;
      } catch {
        // fail-closed
        return [];
      }
    }
  };

  // OAI stub:
  // - Prova proxy: /oai?recordId=
  // - Plus: alltid (om candidate.url finns) en “käll-länk” (typ: link)
  const EnrichOAI = {
    id: "enrich-oai-01",
    supports(candidate) {
      return baseCandidateOk(candidate);
    },
    async enrich(candidate /*, hints */) {
      const bits = [];
      const cUrl = String(candidate && candidate.url ? candidate.url : "");
      const cId  = String(candidate && candidate.id ? candidate.id : "");

      try {
        if (cUrl) {
          bits.push(makeBit(
            "enrich-oai-01",
            "link",
            "Källpost (länk)",
            0.55,
            cUrl,
            { note: "Grundlänk från kandidat.", recordId: cId || "" }
          ));
        }

        if (!cId) return bits;

        // Valfri proxy endpoint: /oai?recordId=<id>
        const probeUrl = PROXY_BASE + "/oai?recordId=" + encodeURIComponent(cId);
        const res = await abortableFetch(probeUrl);
        if (!res.ok) return bits;

        const json = await res.json().catch(() => null);
        const oaiUrl = json && (json.url || json.oaiUrl);
        const ident  = json && (json.identifier || json.oaiIdentifier);

        if (oaiUrl) {
          bits.push(makeBit(
            "enrich-oai-01",
            "oai",
            "OAI-PMH (GetRecord-länk)",
            0.7,
            String(oaiUrl),
            { oaiIdentifier: ident ? String(ident) : "", recordId: cId, note: "Hämtad via proxy." }
          ));
        }

        return bits;
      } catch {
        // fail-closed
        return bits; // behåll ev. käll-länk men inget mer
      }
    }
  };

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
    return Array.from(REGISTRY.values()).map(p => ({
      id: p.id,
      label: p.label
    }));
  }

  function pickProvider(preferred = "auto") {
    if (preferred === "demo") return DemoProvider;
    if (preferred === "searchapi") return SearchApiProvider;
    // auto = proxy först
    return SearchApiProvider || DemoProvider;
  }

  window.RAProviders = {
    // AO-API-01
    listProviders,
    pickProvider,

    // AO-API-03 (för din befintliga person-puzzle.html)
    enrichProviders: [
      EnrichIIIF,
      EnrichOAI
    ]
  };

})();
