/* ============================================================
   ra-providers.js
   ------------------------------------------------------------
   Släktkort – Riksarkivet Providerlager (AO-API-03 PATCH v2)
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
   - Limit utökas till 150 (max 150 visas)
   - Stöd för RA Worker-format: { totalHits, hits: [...] }
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
  const FETCH_TIMEOUT = 8000;

  // Resultatgränser (AO-API-03: 150)
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

  // Robust text plockare: hanterar string/array/object/nestade former
  function pickText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(pickText).filter(Boolean).join(" ").trim();
    if (typeof v === "object") {
      // Vanliga fält i olika API:er
      return pickText(
        v.text ?? v.value ?? v.label ?? v.title ?? v.name ?? v.displayName ?? v.content ?? ""
      );
    }
    return String(v);
  }

  // Försök hitta ett år (4 siffror) i en text/objekt
  function extractYear(v) {
    const s = pickText(v);
    if (!s) return null;
    const m = s.match(/\b(1[0-9]{3}|20[0-9]{2})\b/); // 1000–2099 (fail-safe)
    if (!m) return null;
    const y = Number(m[1]);
    if (!Number.isFinite(y)) return null;
    return y;
  }

  // Försök bygga en “rimlig” länk om url saknas
  function extractUrl(hit) {
    // vanliga: url / uri / link / href
    const direct = safeUrl(pickText(hit && (hit.url ?? hit.uri ?? hit.link ?? hit.href)));
    if (direct) return direct;

    // Ibland finns “id” som kan användas för att länka till sök-portalen
    const id = pickText(hit && (hit.id ?? hit.identifier ?? hit.recordId ?? hit.ref));
    // fail-closed: om vi inte är säkra på korrekt portal-URL, returnera tomt
    // (du kan senare mappa till rätt portal-URL när du vet exakt)
    if (!id) return "";
    return "";
  }

  function extractPlace(hit) {
    // flera varianter
    return (
      pickText(hit && (hit.place ?? hit.location ?? hit.placeName ?? hit.ort ?? hit.city ?? hit.socken)) ||
      ""
    );
  }

  function extractName(hit) {
    // Riksarkivet “hits” kan ha title/label, ibland name finns inte
    const n =
      pickText(hit && (hit.name ?? hit.title ?? hit.label ?? hit.displayName ?? hit.heading ?? hit.caption)) ||
      "";
    return n || "(namn saknas)";
  }

  function extractId(hit) {
    const id = pickText(hit && (hit.id ?? hit.identifier ?? hit.recordId ?? hit.ref));
    if (id) return id;

    // fallback id om saknas (fail-closed: bara intern temporär)
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "tmp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function extractBirthDeath(hit) {
    // Vanliga varianter:
    // birthYear/deathYear, fromTime/toTime, dateFrom/dateTo, years, etc.
    const by =
      extractYear(hit && (hit.birthYear ?? hit.birth ?? hit.fodelsear ?? hit.fromTime ?? hit.dateFrom ?? hit.from)) ??
      null;

    const dy =
      extractYear(hit && (hit.deathYear ?? hit.death ?? hit.dodsar ?? hit.toTime ?? hit.dateTo ?? hit.to)) ??
      null;

    // Fail-safe: om båda saknas, returnera null/null
    return { birthYear: by, deathYear: dy };
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
        .map(p =>
          makeCandidate({
            ...p,
            source: "Demo",
            url: "",
            why: ["Demo-post"]
          })
        );
    }
  };

  /* ============================================================
     RIKSARKIVET – SÖK-API VIA CLOUDFLARE WORKER
     - Din worker: /records?name=Erik&limit=5
     - Svar (ex): { totalHits: 17219, hits: [...] }
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
        "/records?name=" +
        encodeURIComponent(q) +
        "&limit=" +
        String(limit);

      let res;
      try {
        res = await abortableFetch(url);
      } catch {
        // fail-closed: bubbla fel så UI kan visa “källa blockerad”
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

      // ✅ Viktigt: ditt format använder "hits"
      const records = safeArray(json.hits || json.records || json.items || json.data || []);

      // Fail-closed: om records inte är array -> []
      if (!Array.isArray(records)) return [];

      return records.slice(0, limit).map(r => {
        const years = extractBirthDeath(r);
        const candidate = makeCandidate({
          id: extractId(r),
          name: extractName(r),
          birthYear: years.birthYear,
          deathYear: years.deathYear,
          place: extractPlace(r),
          source: "Riksarkivet",
          url: extractUrl(r),
          why: ["Match via namn"]
        });

        // Fail-safe: om vi inte ens fick namn -> minimalt
        if (!candidate.name) candidate.name = "(namn saknas)";
        return candidate;
      });
    }
  };

  /* ============================================================
     ENRICH PROVIDERS (AO-API-03)
     - IIIF / OAI stubs: metadata/länkar endast
     - Ingen bildrendering, ingen lagring
     - Fail-closed: fel -> []
     ============================================================ */

  const enrichProviders = [
    {
      id: "iiif_stub",
      label: "IIIF (stub)",
      supports(candidate) {
        // Vi kräver en URL (om RA senare ger en IIIF-länk kan vi använda den direkt)
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
      async enrich(/* candidate, hints */) {
        // Stub: korrekt OAI identifier kräver mappning mot RA:s OAI-tjänst
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
    // auto = proxy först, annars demo
    return SearchApiProvider || DemoProvider;
  }

  window.RAProviders = {
    listProviders,
    pickProvider,
    enrichProviders
  };
})();
