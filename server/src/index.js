/**
 * Släktkort – Riksarkivet proxy (Cloudflare Worker)
 * -------------------------------------------------
 * Syfte:
 * - Lösa CORS för GitHub Pages (Släktkort)
 * - Fail-closed: tydliga felkoder, inga cachade svar
 *
 * Endpoints:
 * - GET /health
 * - GET /records?name=Karl&limit=50
 *
 * Policy:
 * - Ingen persistent lagring (ingen KV/D1/R2)
 * - Endast GET + OPTIONS (preflight)
 */

const RA_API_BASE = "https://data.riksarkivet.se/api";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

function clampLimit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  const i = Math.trunc(n);
  if (i < 1) return 1;
  if (i > MAX_LIMIT) return MAX_LIMIT;
  return i;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    // Preflight (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "GET") {
      return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405, origin);
    }

    // Health
    if (url.pathname === "/health") {
      return json(
        { ok: true, service: "slaktkort-ra-proxy", version: "1.0.0" },
        200,
        origin
      );
    }

    // Proxy: /records
    if (url.pathname === "/records") {
      const name = String(url.searchParams.get("name") || "").trim();
      const limit = clampLimit(url.searchParams.get("limit"));

      if (name.length < 2) {
        return json({ ok: false, error: "NAME_TOO_SHORT" }, 400, origin);
      }

      const target = new URL(RA_API_BASE + "/records");
      target.searchParams.set("name", name);
      target.searchParams.set("limit", String(limit));

      // Forwarda övriga query params (om du vill stödja fler senare)
      for (const [k, v] of url.searchParams.entries()) {
        if (k === "name" || k === "limit") continue;
        target.searchParams.set(k, v);
      }

      let res;
      try {
        res = await fetch(target.toString(), {
          headers: {
            Accept: "application/json",
            "User-Agent": "slaktkort-ra-proxy/1.0",
          },
        });
      } catch {
        return json({ ok: false, error: "UPSTREAM_FETCH_FAILED" }, 502, origin);
      }

      if (!res.ok) {
        return json(
          { ok: false, error: "UPSTREAM_HTTP_" + res.status },
          502,
          origin
        );
      }

      // Vi skickar vidare rå body (JSON) men med våra CORS headers
      const body = await res.text();

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders(origin),
        },
      });
    }

    // Not found
    return json({ ok: false, error: "NOT_FOUND" }, 404, origin);
  },
};
