/* =========================================================
FILE: app/assets/js/ra-providers.js
========================================================= */
/**
 * Riksarkivet Provider-lager (RA Providers)
 * ----------------------------------------------------------
 * MÅL:
 * - Standardisera sök mot flera källor utan att UI behöver ändras.
 * - Fail-closed + fallback (demo) vid CORS/timeout/fel.
 *
 * LÅST KONTRAKT (AO-API-01):
 * Provider:
 * - id: string
 * - label: string
 * - search(query): Promise<Candidate[]>
 *
 * Candidate (minsta gemensamma):
 * {
 *   id: "string",
 *   name: "string",
 *   birthYear: 1820,
 *   deathYear: 1893,
 *   place: "string",
 *   source: "string",
 *   url: "string",
 *   why: ["string", "string"]
 * }
 *
 * POLICY:
 * - Ingen extern persondata sparas här.
 * - Allt returneras till UI in-memory. UI får välja om import sker.
 */

(function(){
  "use strict";

  // ---------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------
  function isNonEmptyString(v){ return typeof v === "string" && v.trim().length > 0; }

  function safeInt(v){
    const n = Number(v);
    if(!Number.isFinite(n)) return null;
    const i = Math.trunc(n);
    if(i < 0 || i > 3000) return null;
    return i;
  }

  function pickFirstString(){
    for(let i=0;i<arguments.length;i++){
      const v = arguments[i];
      if(isNonEmptyString(v)) return v.trim();
    }
    return "";
  }

  function uniqueWhy(arr){
    const out = [];
    const seen = new Set();
    for(const x of (arr || [])){
      const s = String(x || "").trim();
      if(!s) continue;
      if(seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  async function fetchJsonWithTimeout(url, timeoutMs){
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs|0));

    try{
      const res = await fetch(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal: ctrl.signal,
        headers: { "Accept": "application/json" }
      });

      if(!res.ok){
        const txt = await res.text().catch(() => "");
        const err = new Error("HTTP_" + res.status);
        err.details = txt ? txt.slice(0, 400) : "";
        err.httpStatus = res.status;
        throw err;
      }

      return await res.json();
    }catch(e){
      const msg = String(e && e.message ? e.message : e);
      if(msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("cors")){
        const err = new Error("CORS_OR_NETWORK");
        err.cause = e;
        throw err;
      }
      if(msg.toLowerCase().includes("aborted") || msg.toLowerCase().includes("abort")){
        const err = new Error("TIMEOUT");
        err.cause = e;
        throw err;
      }
      throw e;
    }finally{
      clearTimeout(t);
    }
  }

  // ---------------------------------------------------------
  // Candidate mappning: robust (API-format kan variera)
  // ---------------------------------------------------------
  function tryGet(obj, path){
    // path ex: "foo.bar[0].baz"
    try{
      let cur = obj;
      const parts = String(path).replaceAll("[", ".[").split(".");
      for(const p of parts){
        if(!cur) return undefined;
        if(p.startsWith("[")){
          const idx = Number(p.slice(1, -1));
          if(!Array.isArray(cur)) return undefined;
          cur = cur[idx];
        }else{
          cur = cur[p];
        }
      }
      return cur;
    }catch{
      return undefined;
    }
  }

  function toCandidateFromAny(item, sourceLabel, baseWhy){
    const id =
      pickFirstString(
        item && item.id,
        item && item["@id"],
        item && item.uri,
        item && item.recordId,
        item && item.reference,
        tryGet(item, "identifier"),
        tryGet(item, "record.id"),
        tryGet(item, "hit.id")
      ) || ("ra_" + Math.random().toString(36).slice(2,10));

    const name =
      pickFirstString(
        item && item.name,
        item && item.title,
        item && item.label,
        item && item.prefLabel,
        tryGet(item, "rdfs:label.[0].@value"),
        tryGet(item, "rdfs:label.[0].value"),
        tryGet(item, "displayLabel"),
        tryGet(item, "record.title")
      ) || "(namn saknas)";

    const birthYear =
      safeInt(item && item.birthYear) ??
      safeInt(tryGet(item, "birth.year")) ??
      safeInt(tryGet(item, "lifeSpan.birthYear")) ??
      null;

    const deathYear =
      safeInt(item && item.deathYear) ??
      safeInt(tryGet(item, "death.year")) ??
      safeInt(tryGet(item, "lifeSpan.deathYear")) ??
      null;

    const place =
      pickFirstString(
        item && item.place,
        item && item.location,
        tryGet(item, "topography"),
        tryGet(item, "record.place"),
        tryGet(item, "placeName")
      );

    let url =
      pickFirstString(
        item && item.url,
        item && item["@id"],
        item && item.uri,
        tryGet(item, "links.self"),
        tryGet(item, "record.url")
      );

    if(url && !/^https?:\/\//i.test(url)){
      if(url.startsWith("/")) url = "https://data.riksarkivet.se" + url;
    }

    const why = uniqueWhy([].concat(baseWhy || [], place ? ("Plats: " + place) : []));

    return {
      id: String(id),
      name: String(name),
      birthYear: birthYear === null ? null : birthYear,
      deathYear: deathYear === null ? null : deathYear,
      place: place || "",
      source: String(sourceLabel || "Okänd källa"),
      url: url || "",
      why
    };
  }

  function extractItemsFromRecordsResponse(data){
    if(Array.isArray(data)) return data;

    if(data && Array.isArray(data.records)) return data.records;
    if(data && Array.isArray(data.hits)) return data.hits;
    if(data && Array.isArray(data.items)) return data.items;
    if(data && data.result && Array.isArray(data.result.records)) return data.result.records;
    if(data && Array.isArray(data.data)) return data.data;

    return [];
  }

  // ---------------------------------------------------------
  // DemoProvider (fallback)
  // ---------------------------------------------------------
  function createDemoProvider(){
    const DEMO = [
      { fornamn:"Karl",  efternamn:"Johansson",  fodelsear:"1872", dodsar:"1939", plats:"Falun",   yrke:"Smed" },
      { fornamn:"Anna",  efternamn:"Persdotter", fodelsear:"1878", dodsar:"1951", plats:"Leksand", yrke:"Piga" },
      { fornamn:"Erik",  efternamn:"Lind",       fodelsear:"1901", dodsar:"1977", plats:"Gävle",   yrke:"Lokförare" },
      { fornamn:"Maria", efternamn:"Nilsdotter", fodelsear:"1822", dodsar:"1890", plats:"Uppsala", yrke:"Sömmerska" },
      { fornamn:"Olof",  efternamn:"Bergström",  fodelsear:"1799", dodsar:"1866", plats:"Örebro",  yrke:"Handlare" }
    ];

    function normalize(s){ return String(s || "").trim().toLowerCase(); }
    function parseYear(v){ const i = safeInt(String(v||"").trim()); return i === null ? null : i; }

    return {
      id: "demo",
      label: "Demo (offline)",
      async search(query){
        const q = normalize(query);
        if(!q || q.length < 2) return [];

        const hits = DEMO.filter(x => {
          const full = normalize((x.fornamn||"") + " " + (x.efternamn||""));
          const place = normalize(x.plats||"");
          return full.includes(q) || place.includes(q);
        });

        return hits.map((x, idx) => ({
          id: "demo_" + idx,
          name: ((x.fornamn||"") + " " + (x.efternamn||"")).trim(),
          birthYear: parseYear(x.fodelsear),
          deathYear: parseYear(x.dodsar),
          place: String(x.plats||""),
          source: "Demo",
          url: "",
          why: ["Fallback: demo-data", "Match: namn/plats"]
        }));
      }
    };
  }

  // ---------------------------------------------------------
  // SearchApiProvider (Riksarkivet Sök-API, records)
  // ---------------------------------------------------------
  function createSearchApiProvider(opts){
    const baseUrl = (opts && opts.baseUrl) ? String(opts.baseUrl) : "https://data.riksarkivet.se/api/records";
    const timeoutMs = (opts && opts.timeoutMs) ? Number(opts.timeoutMs) : 7000;

    function buildUrl(params){
      const u = new URL(baseUrl);

      if(isNonEmptyString(params.name)) u.searchParams.set("name", params.name);
      else if(isNonEmptyString(params.text)) u.searchParams.set("text", params.text);

      if(isNonEmptyString(params.place)) u.searchParams.set("place", params.place);

      if(params.yearMin != null) u.searchParams.set("year_min", String(params.yearMin));
      if(params.yearMax != null) u.searchParams.set("year_max", String(params.yearMax));

      u.searchParams.set("limit", String(params.limit != null ? params.limit : 50));
      u.searchParams.set("offset", String(params.offset != null ? params.offset : 0));
      u.searchParams.set("sort", String(params.sort || "relevance"));

      if(isNonEmptyString(params.facet)) u.searchParams.set("facet", params.facet);

      return u.toString();
    }

    async function searchBase(params, why){
      const q = pickFirstString(params.name, params.text);
      if(!q || q.trim().length < 2) return [];

      const url = buildUrl(params);
      const data = await fetchJsonWithTimeout(url, timeoutMs);

      const items = extractItemsFromRecordsResponse(data);
      const out = [];

      for(const it of items){
        out.push(toCandidateFromAny(it, "Riksarkivet Sök-API", why));
      }

      return out;
    }

    return {
      id: "searchapi",
      label: "Riksarkivet Sök-API (beta)",
      async search(query){
        const q = String(query || "").trim();
        return await searchBase({
          name: q,
          limit: 50,
          offset: 0,
          sort: "relevance",
          facet: "ObjectType:Agent;Type:Person"
        }, ["Match: name", "Källa: Sök-API"]);
      },

      // OPTIONAL (puzzle kan använda om den vill)
      async refine(params){
        const name = pickFirstString(params && params.name, "");
        const place = pickFirstString(params && params.place, "");
        const yearMin = safeInt(params && params.yearMin);
        const yearMax = safeInt(params && params.yearMax);

        return await searchBase({
          name,
          place,
          yearMin,
          yearMax,
          limit: 100,
          offset: 0,
          sort: "relevance",
          facet: "ObjectType:Agent;Type:Person"
        }, [
          "Refine: name/place/year",
          place ? ("Filter: place=" + place) : "",
          (yearMin != null || yearMax != null) ? ("Filter: year=" + String(yearMin||"") + "–" + String(yearMax||"")) : ""
        ]);
      }
    };
  }

  // ---------------------------------------------------------
  // Registry + global API
  // ---------------------------------------------------------
  const registry = new Map();
  const demoProvider = createDemoProvider();
  const searchApiProvider = createSearchApiProvider();

  registry.set(demoProvider.id, demoProvider);
  registry.set(searchApiProvider.id, searchApiProvider);

  function getProvider(id){
    const p = registry.get(String(id || ""));
    return p || null;
  }

  /**
   * pickProvider({ preferred, allowNetwork })
   * preferred: "demo" | "searchapi" | "auto"
   */
  function pickProvider(opts){
    const preferred = String((opts && opts.preferred) || "auto");
    const allowNetwork = (opts && typeof opts.allowNetwork === "boolean") ? opts.allowNetwork : true;

    if(preferred === "demo") return demoProvider;
    if(preferred === "searchapi") return (allowNetwork ? searchApiProvider : demoProvider);

    // auto
    return (allowNetwork ? searchApiProvider : demoProvider);
  }

  window.RAProviders = {
    getProvider,
    pickProvider,
    listProviders: () => Array.from(registry.values()).map(p => ({ id: p.id, label: p.label }))
  };
})();

