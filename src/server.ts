import { decode } from "@msgpack/msgpack";
import { gunzipSync } from "node:zlib";
import type { Span, SentryError } from "./types.js";
import { bus } from "./events.js";
import * as apiStore from "./api-store.js";

export type ServerConfig = {
  ddPort: number;
  sentryPort: number;
  /** Resource patterns to drop (substring match on span resource). */
  dropPatterns?: string[];
};

export type Servers = {
  dd: ReturnType<typeof Bun.serve>;
  sentry: ReturnType<typeof Bun.serve>;
  stop: () => void;
};

function parseDatadogSpans(decoded: unknown): Span[] {
  const spans: Span[] = [];
  if (!Array.isArray(decoded)) return spans;

  for (const traceGroup of decoded) {
    if (!Array.isArray(traceGroup)) continue;
    for (const raw of traceGroup) {
      spans.push({
        traceId: String(raw.trace_id ?? raw.traceID ?? ""),
        spanId: String(raw.span_id ?? raw.spanID ?? ""),
        parentId: String(raw.parent_id ?? raw.parentID ?? "0"),
        name: raw.name ?? "",
        service: raw.service ?? "",
        resource: raw.resource ?? "",
        type: raw.type ?? "",
        start: Number(raw.start ?? 0),
        duration: Number(raw.duration ?? 0),
        error: raw.error ?? 0,
        meta: raw.meta ?? {},
        metrics: raw.metrics ?? {},
      });
    }
  }

  return spans;
}

function parseSentryEnvelope(
  text: string,
): { type: string; payload: any }[] | null {
  const lines = text.split("\n");
  if (lines.length < 2) return null;

  try {
    JSON.parse(lines[0]); // envelope header — we don't need it
  } catch {
    return null;
  }

  const items: { type: string; payload: any }[] = [];
  let i = 1;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    let itemHeader: any;
    try {
      itemHeader = JSON.parse(lines[i]);
    } catch {
      i++;
      continue;
    }
    i++;
    if (i < lines.length) {
      let payload: any;
      try {
        payload = JSON.parse(lines[i]);
      } catch {
        payload = lines[i];
      }
      items.push({ type: itemHeader.type, payload });
    }
    i++;
  }

  return items;
}

function extractExceptionMessage(payload: any): string | null {
  const values = payload?.exception?.values;
  if (values?.length > 0) {
    const exc = values[0];
    return exc.type ? `${exc.type}: ${exc.value}` : exc.value;
  }
  return null;
}

function extractStacktrace(payload: any) {
  const values = payload?.exception?.values;
  if (values?.length > 0 && values[0].stacktrace) {
    return values[0].stacktrace;
  }
  return null;
}

export function startServers(config: ServerConfig): Servers {
  const { ddPort, sentryPort, dropPatterns = [] } = config;

  function filterSpans(spans: Span[]): Span[] {
    return spans.filter((s) => {
      // Honor manual.drop / sampling priority (same as real DD Agent)
      // dd-trace sets metrics._sampling_priority_v1 = -1 for USER_REJECT
      const priority = s.metrics?.["_sampling_priority_v1"];
      if (priority !== undefined && priority < 0) return false;

      // Honor --drop patterns
      if (dropPatterns.length > 0) {
        const resource = s.resource || s.name;
        if (dropPatterns.some((p) => resource.includes(p))) return false;
      }

      return true;
    });
  }

  function onSpans(spans: Span[]) {
    const filtered = filterSpans(spans);
    if (filtered.length > 0) bus.emit("spans", filtered);
  }
  function onError(error: SentryError) { bus.emit("error", error); }
  function log(source: "dd" | "sentry", msg: string) { bus.emit("log", { source, msg }); }

  const dd = Bun.serve({
    port: ddPort,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }

      // Health/info
      if (url.pathname === "/" || url.pathname === "/info") {
        return Response.json({
          endpoints: ["/v0.4/traces", "/v0.5/traces", "/v0.7/traces"],
          client_drop_p0s: false,
          version: "local-otel-1.0.0",
        });
      }

      // ─── Query API (for agents/LLMs) ─────────────────────────

      if (url.pathname === "/api/summary") {
        return Response.json(apiStore.getSummary());
      }

      if (url.pathname === "/api/services") {
        return Response.json(apiStore.getServices());
      }

      if (url.pathname === "/api/traces") {
        const service = url.searchParams.get("service") ?? undefined;
        const limit = url.searchParams.has("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : 50;
        return Response.json(apiStore.getTraces({ service, limit }));
      }

      if (url.pathname.startsWith("/api/traces/")) {
        const traceId = url.pathname.slice("/api/traces/".length);
        const trace = apiStore.getTrace(traceId);
        if (!trace) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(trace);
      }

      if (url.pathname === "/api/errors") {
        const level = url.searchParams.get("level") ?? undefined;
        const limit = url.searchParams.has("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : 50;
        return Response.json(apiStore.getErrors({ level, limit }));
      }

      if (url.pathname === "/api/clear" && req.method === "POST") {
        apiStore.clear();
        return Response.json({ ok: true });
      }

      // Trace endpoints
      if (/\/v0\.\d\/traces/.test(url.pathname) || /\/api\/v0\.\d\/traces/.test(url.pathname)) {
        try {
          let body = Buffer.from(await req.arrayBuffer());
          if (body.length === 0) {
            return new Response("OK");
          }

          // Decompress gzip if needed
          const encoding = req.headers.get("content-encoding");
          if (encoding === "gzip") {
            body = gunzipSync(body) as Buffer;
          }

          let decoded: unknown;
          const contentType = req.headers.get("content-type") ?? "";
          if (contentType.includes("msgpack")) {
            decoded = decode(body);
          } else if (contentType.includes("json")) {
            decoded = JSON.parse(body.toString());
          } else {
            try {
              decoded = decode(body);
            } catch {
              decoded = JSON.parse(body.toString());
            }
          }

          const spans = parseDatadogSpans(decoded);
          if (spans.length > 0) {
            onSpans(spans);
            const traceIds = new Set(spans.map((s) => s.traceId));
            log("dd", `${spans.length} span(s), ${traceIds.size} trace(s)`);
          }

          return Response.json({ rate_by_service: {} });
        } catch (err: any) {
          log("dd", `Error: ${err.message}`);
          return new Response("Bad Request", { status: 400 });
        }
      }

      // Stats endpoint — dd-trace sends these periodically
      if (/\/v0\.\d\/stats/.test(url.pathname) || /\/api\/v0\.\d\/stats/.test(url.pathname)) {
        await req.arrayBuffer(); // drain
        return Response.json({});
      }

      // Catch-all
      if (req.method === "PUT" || req.method === "POST") {
        await req.arrayBuffer();
      }
      return new Response("OK");
    },
  });

  const sentry = Bun.serve({
    port: sentryPort,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }

      // Envelope endpoint
      if (url.pathname.includes("/envelope")) {
        try {
          const text = await req.text();
          const items = parseSentryEnvelope(text);

          if (items) {
            for (const item of items) {
              if (item.type === "event" && item.payload) {
                const p = item.payload;
                const error: SentryError = {
                  id: p.event_id || crypto.randomUUID(),
                  timestamp: p.timestamp
                    ? new Date(p.timestamp * 1000).toISOString()
                    : new Date().toISOString(),
                  level: p.level || "error",
                  message:
                    p.message || extractExceptionMessage(p) || "Unknown error",
                  exception: p.exception,
                  tags: p.tags,
                  contexts: p.contexts,
                  platform: p.platform,
                  environment: p.environment,
                  release: p.release,
                  breadcrumbs: p.breadcrumbs,
                  stacktrace: extractStacktrace(p),
                  receivedAt: Date.now(),
                };

                onError(error);
                const msg =
                  error.message.length > 60
                    ? error.message.slice(0, 59) + "…"
                    : error.message;
                log("sentry", `${error.level}: ${msg}`);
              }
            }
          }

          return Response.json({ id: "ok" });
        } catch (err: any) {
          log("sentry", `Error: ${err.message}`);
          return new Response("Bad Request", { status: 400 });
        }
      }

      // Store endpoint (older SDKs)
      if (url.pathname.includes("/store")) {
        try {
          const p = await req.json();
          const error: SentryError = {
            id: p.event_id || crypto.randomUUID(),
            timestamp: p.timestamp
              ? new Date(p.timestamp * 1000).toISOString()
              : new Date().toISOString(),
            level: p.level || "error",
            message: p.message || extractExceptionMessage(p) || "Unknown error",
            exception: p.exception,
            tags: p.tags,
            contexts: p.contexts,
            platform: p.platform,
            environment: p.environment,
            release: p.release,
            breadcrumbs: p.breadcrumbs,
            stacktrace: extractStacktrace(p),
            receivedAt: Date.now(),
          };

          onError(error);
          log("sentry", `${error.level}: ${error.message.slice(0, 60)}`);
          return Response.json({ id: error.id });
        } catch (err: any) {
          log("sentry", `Error: ${err.message}`);
          return new Response("Bad Request", { status: 400 });
        }
      }

      return Response.json({ ok: true });
    },
  });

  return {
    dd,
    sentry,
    stop() {
      dd.stop(true);
      sentry.stop(true);
    },
  };
}
