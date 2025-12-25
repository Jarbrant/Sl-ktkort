/* ============================================================
   ra-providers.js
   ------------------------------------------------------------
   Släktkort – Riksarkivet Providerlager (AO-API-01)
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
        id: r.id || r.identifier || crypto.randomUUID(),
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
    listProviders,
    pickProvider
  };

})();
