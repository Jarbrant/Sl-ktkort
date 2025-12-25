/* ============================================================
   ra-providers.js
   ------------------------------------------------------------
   Släktkort – Riksarkivet Providerlager (AO-API-01)
   Mål:
   - Providerstruktur som UI kan använda utan att UI behöver veta
     om det är demo, direkt-API eller proxy.
   - Fail-closed: om krav inte uppfylls => kasta fel (UI fallbackar).
   - Ingen automatisk lagring av extern persondata.
   - Session-only i UI (person-search/person-puzzle) – inte här.

   Providers:
   - demo: lokal demo/testdata
   - searchapi_proxy: via Cloudflare Worker (löser CORS)
   - searchapi_direct: direkt mot data.riksarkivet.se (kan CORS-blockas)
   ------------------------------------------------------------ */

(function(){
  "use strict";

  // ============================================================
  // KONFIG (LÅST: ej i storage)
  // ============================================================
  // Sätt denna till din publika Worker-URL (inte dashboard-länken):
  // Exempel: "https://slaktkort01234.<dittkonto>.workers.dev"
  const PROXY_BASE = ""; // <-- FYLL I

  // Riksarkivet Sök-API base (direkt)
  const RA_BASE = "https://data.riksarkivet.se/api";

  // Timeouts (ms)
  const FETCH_TIMEOUT_MS = 8000;

  // Begränsa resultat för att skydda både UI och upstream
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;

  // ============================================================
  // HELPERS
  // ============================================================
  function clampInt(n, min, max, fallback){
    const x = Number(n);
    if(!Number.isFinite(x)) return fallback;
    const i = Math.trunc(x);
    if(i < min) return min;
    if(i > max) return max;
    return i;
  }

  function toStr(v){ return String(v == null ? "" : v); }

  function normalize(s){
    return toStr(s).trim().toLowerCase();
  }

  function safeArray(v){
    return Array.isArray(v) ? v : [];
  }

  function abortableFetch(url, opts){
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const merged = Object.assign({}, (opts || {}), { signal: controller.signal });

    return fetch(url, merged)
      .finally(() => clearTimeout(id));
  }

  function corsOrNetworkError(err){
    // Browser: "TypeError: Failed to fetch" vid CORS/nätverk
    const msg = (err && err.message) ? String(err.message) : String(err || "");
    const lower = msg.toLowerCase();
    if(lower.includes("failed to fetch") || lower.includes("network") || lower.includes("cors")){
      return true;
    }
    // AbortError räknas inte som CORS, men som timeout (hanteras separat)
    return false;
  }

  function isAbortError(err){
    const name = err && err.name ? String(err.name) : "";
    return name === "AbortError";
  }

  function mustString(v){
    const s = toStr(v).trim();
    return s ? s : "";
  }

  // ============================================================
  // Candidate mapping (LÅST format)
  // { id, name, birthYear, deathYear, place, source, url, why[] }
  // ============================================================
  function makeCandidate(partial){
    const c = partial || {};
    return {
      id: mustString(c.id),
      name: mustString(c.name),
      birthYear: (c.birthYear == null ? null : Number(c.birthYear)),
      deathYear: (c.deathYear == null ? null : Number(c.deathYear)),
      place: mustString(c.place),
      source: mustString(c.source),
      url: mustString(c.url),
      why: safeArray(c.why).map(x => mustString(x)).filter(Boolean)
    };
  }

  // ============================================================
  // DEMO provider (för fallback)
  // ============================================================
  const DEMO = [
    { id:"demo_1", name:"Karl Johansson", birthYear:1872, deathYear:1939, place:"Falun", source:"Demo", url:"", why:["Demo-post"] },
    { id:"demo_2", name:"Anna Persdotter", birthYear:1878, deathYear:1951, place:"Leksand", source:"Demo", url:"", why:["Demo-post"] },
    { id:"demo_3", name:"Erik Lind", birthYear:1901, deathYear:1977, place:"Gävle", source:"Demo", url:"", why:["Demo-post"] },
    { id:"demo_4", name:"Maria Nilsdotter", birthYear:1822, deathYear:1890, place:"Uppsala", source:"Demo", url:"", why:["Demo-post"] },
    { id:"demo_5", name:"Olof Bergström", birthYear:1799, deathYear:1866, place:"Örebro", source:"Demo", url:"", why:["Demo-post"] }
  ];

  const DemoProvider = {
    id: "demo",
    label: "Demo (offline)",
    async search(query){
      const q = normalize(query);
      if(!q || q.length < 2) return [];
      const hits = DEMO.filter(x => normalize(x.name).includes(q) || normalize(x.place).includes(q));
      return hits.map(makeCandidate);
    }
  };

  // ============================================================
  // Riksarkivet Sök-API v0 (proxy/direct)
  // OBS: Vi håller detta minimalt och robust.
  // ============================================================
  function buildRecordsUrl(base, query, limit){
    // base: "https://.../api" (direct) ELLER "https://...workers.dev" (proxy)
    // direct endpoint: /records
    // proxy endpoint:  /records  (workern mappar till /api/records)
    const q = mustString(query);
    if(!q || q.length < 2) return "";

    const lim = clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);

    const u = new URL(base.replace(/\/+$/, "") + "/records");
    u.searchParams.set("name", q);
    u.searchParams.set("limit", String(lim));
    u.searchParams.set("offset", "0");
    u.searchParams.set("sort", "relevance");

    // Lätt “hint” – kan ändras senare, men hjälper relevans:
    // (Om RA ignorerar okända params är det fine.)
    // u.searchParams.set("facet", "ObjectType:Agent;Type:Person");

    return u.toString();
  }

  function mapRecordsToCandidates(payload, sourceLabel){
    // payload-format kan variera. Vi mappar defensivt.
    // Målet: få ut id + label/name + ev år + ev plats + ev url.
    const out = [];

    // Vanliga mönster: payload.records / payload.items / payload.hits
    const records =
      safeArray(payload && payload.records) ||
      safeArray(payload && payload.items) ||
      safeArray(payload && payload.hits) ||
      [];

    for(const r of records){
      // Fält kan heta olika: id/identifier/uri, title/name/label
      const id =
        mustString(r && (r.id || r.identifier || r.uri || r.arkivid || r.guid));

      const name =
        mustString(r && (r.name || r.title || r.label || r.displayName));

      // År: ibland finns interval/årtal i olika fält.
      // Vi tar bara heltal om vi hittar dem.
      let birthYear = null;
      let deathYear = null;

      const by = r && (r.birthYear || r.birth || r.fodelsear || r.yearOfBirth);
      const dy = r && (r.deathYear || r.death || r.dodsar || r.yearOfDeath);

      const bNum = Number(by);
      const dNum = Number(dy);
      if(Number.isFinite(bNum)) birthYear = Math.trunc(bNum);
      if(Number.isFinite(dNum)) deathYear = Math.trunc(dNum);

      const place =
        mustString(r && (r.place || r.location || r.plats || r.placeName));

      const url =
        mustString(r && (r.url || r.link || r.href || r.uri)) ||
        (id ? ("https://data.riksarkivet.se/" + encodeURIComponent(id)) : "");

      // Varför: keep short
      const why = [];
      if(sourceLabel) why.push(sourceLabel);
      if(place) why.push("Plats: " + place);

      const cand = makeCandidate({
        id: id || ("ra_" + Math.random().toString(36).slice(2)),
        name: name || "(namn saknas)",
        birthYear,
        deathYear,
        place,
        source: sourceLabel,
        url,
        why
      });

      // Minimivalidering enligt kontraktet: id + name måste finnas
      if(cand.id && cand.name) out.push(cand);
    }

    return out;
  }

  function makeSearchApiProvider(opts){
    const id = opts.id;
    const label = opts.label;
    const base = opts.base; // PROXY_BASE or RA_BASE
    const sourceLabel = opts.sourceLabel;

    return {
      id,
      label,

      // --------------------------------------------------------
      // search(query): Promise<Candidate[]>
      // - Fail-closed: kasta fel vid nät/CORS/timeout/HTTP
      // - Returnera [] om query för kort
      // --------------------------------------------------------
      async search(query){
        const url = buildRecordsUrl(base, query, DEFAULT_LIMIT);
        if(!url) return [];

        let res;
        try{
          res = await abortableFetch(url, { method:"GET", headers:{ "Accept":"application/json" } });
        }catch(err){
          if(isAbortError(err)){
            throw new Error("TIMEOUT");
          }
          if(corsOrNetworkError(err)){
            throw new Error("CORS_OR_NETWORK");
          }
          throw new Error("NETWORK_UNKNOWN");
        }

        if(!res || !res.ok){
          const code = res ? res.status : 0;
          throw new Error("HTTP_" + String(code || "0"));
        }

        let json;
        try{
          json = await res.json();
        }catch{
          throw new Error("BAD_JSON");
        }

        // Proxy kan välja att returnera {ok:false,...}
        if(json && json.ok === false){
          const e = mustString(json.error) || "UPSTREAM_ERROR";
          throw new Error(e);
        }

        return mapRecordsToCandidates(json, sourceLabel);
      },

      // --------------------------------------------------------
      // refine(...) – valfritt. Förberett men inte krav nu.
      // Person-puzzle aktiverar knappen bara om refine finns.
      // --------------------------------------------------------
      async refine(params){
        // Minimal v0: bygg en bättre query-sträng och kör search igen.
        // Detta ändrar inte UI och kräver inte ny datamodell.
        const name = mustString(params && params.name);
        if(!name || name.length < 2) return [];

        const place = mustString(params && params.place);
        const yearMin = params && Number.isFinite(params.yearMin) ? Math.trunc(params.yearMin) : null;
        const yearMax = params && Number.isFinite(params.yearMax) ? Math.trunc(params.yearMax) : null;

        // Bygg en “förfinad” söksträng (kan justeras senare)
        // Ex: "Karl Johansson Falun 1820 1890"
        const parts = [name];
        if(place) parts.push(place);
        if(yearMin != null) parts.push(String(yearMin));
        if(yearMax != null) parts.push(String(yearMax));

        const q = parts.join(" ").trim();
        return this.search(q);
      }
    };
  }

  const SearchApiProxyProvider = makeSearchApiProvider({
    id: "searchapi",
    label: "Riksarkivet Sök-API (via Cloudflare proxy)",
    base: (PROXY_BASE || "").replace(/\/+$/, ""),
    sourceLabel: "Riksarkivet (proxy)"
  });

  const SearchApiDirectProvider = makeSearchApiProvider({
    id: "searchapi_direct",
    label: "Riksarkivet Sök-API (direkt, kan CORS-blockas)",
    base: RA_BASE,
    sourceLabel: "Riksarkivet (direkt)"
  });

  // ============================================================
  // Provider registry
  // ============================================================
  const registry = new Map();

  function register(p){
    if(!p || !p.id || typeof p.search !== "function") return;
    registry.set(String(p.id), p);
  }

  register(DemoProvider);

  // Viktigt: bara registrera proxy-provider om PROXY_BASE är satt,
  // annars blir den “trasig” och vi vill fail-closed tidigt.
  if(mustString(PROXY_BASE)){
    register(SearchApiProxyProvider);
  }

  register(SearchApiDirectProvider);

  // ============================================================
  // Public API (window.RAProviders)
  // ============================================================
  function listProviders(){
    return Array.from(registry.values()).map(p => ({ id: p.id, label: p.label }));
  }

  function getProvider(id){
    return registry.get(String(id)) || null;
  }

  /**
   * pickProvider({ preferred, allowNetwork })
   * preferred: "auto" | "demo" | "searchapi" | "searchapi_direct"
   *
   * auto-regel:
   * - Om proxy finns -> använd proxy searchapi
   * - annars om allowNetwork -> direct
   * - annars demo
   */
  function pickProvider(opts){
    const preferred = opts && opts.preferred ? String(opts.preferred) : "auto";
    const allowNetwork = !(opts && opts.allowNetwork === false);

    if(preferred === "demo") return getProvider("demo");

    if(preferred === "searchapi"){
      // "searchapi" betyder proxy-variant i detta system
      const p = getProvider("searchapi");
      if(p) return p;
      // om proxy saknas: fall tillbaka till direct om tillåtet
      if(allowNetwork) return getProvider("searchapi_direct");
      return getProvider("demo");
    }

    if(preferred === "searchapi_direct"){
      if(allowNetwork) return getProvider("searchapi_direct");
      return getProvider("demo");
    }

    // auto
    const proxy = getProvider("searchapi");
    if(proxy) return proxy;

    if(allowNetwork) return getProvider("searchapi_direct");

    return getProvider("demo");
  }

  // Exponera i global scope
  window.RAProviders = {
    listProviders,
    getProvider,
    pickProvider
  };

})();
