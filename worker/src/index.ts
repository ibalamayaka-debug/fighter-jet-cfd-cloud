/**
 * Cloudflare Worker Edge Gateway for F-16 Fighter Jet 3D CFD Cloud ($0/month).
 *
 * - SHA-256 parameter caching in Cloudflare KV (F16_KV)
 * - Dispatches cache misses to Modal 4-core OpenFOAM v2512 `snappyHexMesh + simpleFoam`
 * - Serves jet.vtp, streamlines.vtp, slice_y.vtp, slice_z.vtp with immutable CDN headers
 */

export interface Env {
  F16_KV: KVNamespace;
  RATE_LIMIT_KV?: KVNamespace;
  COMPUTE_ENDPOINT_URL?: string;
  COMPUTE_AUTH_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
  MAX_RUNS_PER_IP_PER_HOUR?: string;
}

interface NormalizedParams {
  aoa_deg: number;
  speed_ms: number;
  altitude_m: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function normalizeParams(raw: Record<string, unknown>): NormalizedParams {
  const aoa_deg = Math.round(clamp(Number(raw.aoa_deg ?? 8), -4, 16) / 2) * 2;
  const speed_ms = Math.round(clamp(Number(raw.speed_ms ?? 180), 80, 280) / 10) * 10;
  const altitude_m = Math.round(clamp(Number(raw.altitude_m ?? 0), 0, 10000) / 2500) * 2500;
  return { aoa_deg, speed_ms, altitude_m };
}

async function computeCaseKey(p: NormalizedParams): Promise<string> {
  const canonical = `f16|aoa=${p.aoa_deg.toFixed(0)}|v=${p.speed_ms.toFixed(0)}|alt=${p.altitude_m.toFixed(0)}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const configured = env.ALLOWED_ORIGIN || "*";
  let allow = configured;
  if (configured !== "*" && origin) {
    const list = configured.split(",").map((s) => s.trim());
    allow = list.includes(origin) ? origin : list[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResp(data: unknown, env: Env, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(env, origin),
    },
  });
}

async function checkRateLimit(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number }> {
  const limit = Number(env.MAX_RUNS_PER_IP_PER_HOUR || "8");
  if (!env.RATE_LIMIT_KV || limit <= 0) {
    return { allowed: true, remaining: limit };
  }
  const bucket = Math.floor(Date.now() / 3_600_000);
  const key = `f16_rl:${ip}:${bucket}`;
  const current = Number((await env.RATE_LIMIT_KV.get(key)) || "0");
  if (current >= limit) {
    return { allowed: false, remaining: 0 };
  }
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 3700 });
  return { allowed: true, remaining: limit - current - 1 };
}

function resultUrls(caseKey: string) {
  return {
    jet: `/api/results/${caseKey}/jet.vtp`,
    streamlines: `/api/results/${caseKey}/streamlines.vtp`,
    slice_y: `/api/results/${caseKey}/slice_y.vtp`,
    slice_z: `/api/results/${caseKey}/slice_z.vtp`,
    metrics: `/api/results/${caseKey}/metrics.json`,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }

    if (request.method === "GET" && path === "/api/health") {
      return jsonResp(
        { status: "ok", aircraft: "F-16", compute_configured: Boolean(env.COMPUTE_ENDPOINT_URL) },
        env,
        origin
      );
    }

    if (request.method === "GET" && path === "/api/cases") {
      const listed = await env.F16_KV.list({ prefix: "meta:", limit: 40 });
      const cases = await Promise.all(
        listed.keys.map(async (k) => {
          const txt = await env.F16_KV.get(k.name, "text");
          if (!txt) return null;
          try {
            return JSON.parse(txt);
          } catch {
            return null;
          }
        })
      );
      return jsonResp({ cases: cases.filter(Boolean) }, env, origin);
    }

    if (request.method === "GET" && path.startsWith("/api/results/")) {
      const parts = path.slice("/api/results/".length).split("/");
      if (parts.length !== 2) {
        return jsonResp({ error: "Invalid result path" }, env, origin, 400);
      }
      const [caseKey, fname] = parts;
      const allowed = new Set(["jet.vtp", "streamlines.vtp", "slice_y.vtp", "slice_z.vtp", "metrics.json"]);
      if (!/^[a-f0-9]{16}$/.test(caseKey) || !allowed.has(fname)) {
        return jsonResp({ error: "Invalid case key or file" }, env, origin, 400);
      }
      const txt = await env.F16_KV.get(`cases/${caseKey}/${fname}`, "text");
      if (txt === null) {
        return jsonResp({ error: "Result not found" }, env, origin, 404);
      }
      const ctype = fname.endsWith(".json")
        ? "application/json; charset=utf-8"
        : "application/xml; charset=utf-8";
      return new Response(txt, {
        status: 200,
        headers: {
          "Content-Type": ctype,
          "Cache-Control": "public, max-age=31536000, immutable",
          ...corsHeaders(env, origin),
        },
      });
    }

    if (request.method === "POST" && path === "/api/simulate") {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResp({ error: "Invalid JSON" }, env, origin, 400);
      }

      const params = normalizeParams(body);
      const caseKey = await computeCaseKey(params);
      const force = Boolean(body.force);

      if (!force) {
        const cachedTxt = await env.F16_KV.get(`cases/${caseKey}/metrics.json`, "text");
        if (cachedTxt) {
          return jsonResp(
            {
              status: "ok",
              cached: true,
              backend: "cloudflare-kv-cache",
              case_key: caseKey,
              metrics: JSON.parse(cachedTxt),
              urls: resultUrls(caseKey),
            },
            env,
            origin
          );
        }
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await checkRateLimit(ip, env);
      if (!rate.allowed) {
        return jsonResp(
          { error: "Hourly cloud simulation quota reached. Click cached flight presets below!" },
          env,
          origin,
          429
        );
      }

      if (!env.COMPUTE_ENDPOINT_URL) {
        return jsonResp({ error: "COMPUTE_ENDPOINT_URL not configured" }, env, origin, 503);
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.COMPUTE_AUTH_TOKEN) {
        headers["Authorization"] = `Bearer ${env.COMPUTE_AUTH_TOKEN}`;
      }

      const resp = await fetch(env.COMPUTE_ENDPOINT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });

      if (!resp.ok) {
        const detail = await resp.text();
        return jsonResp(
          { error: `Cloud OpenFOAM failed (${resp.status}): ${detail.slice(0, 400)}` },
          env,
          origin,
          502
        );
      }

      const data = (await resp.json()) as {
        metrics: Record<string, unknown>;
        files_content?: Record<string, string>;
      };

      const metricsStr = JSON.stringify(data.metrics);
      const writes: Promise<void>[] = [
        env.F16_KV.put(`cases/${caseKey}/metrics.json`, metricsStr),
        env.F16_KV.put(`meta:${caseKey}`, metricsStr),
      ];
      if (data.files_content) {
        for (const [fname, content] of Object.entries(data.files_content)) {
          writes.push(env.F16_KV.put(`cases/${caseKey}/${fname}`, content));
        }
      }
      await Promise.all(writes);

      return jsonResp(
        {
          status: "ok",
          cached: false,
          backend: "modal-openfoam-f16",
          case_key: caseKey,
          remaining_quota: rate.remaining,
          metrics: data.metrics,
          urls: resultUrls(caseKey),
        },
        env,
        origin
      );
    }

    return jsonResp({ error: "Not found" }, env, origin, 404);
  },
};
