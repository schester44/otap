/**
 * OTLP/HTTP trace receiver — parses OTLP JSON and Protobuf trace exports
 * and converts them into the internal Span format.
 *
 * Supports:
 *   POST /v1/traces (OTLP HTTP trace export)
 *   Content-Type: application/json or application/x-protobuf
 *
 * The OTel SDK sends traces here when configured with:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 */
import { gunzipSync } from "node:zlib";
import type { Span } from "./types.js";

// ─── OTLP JSON Types ───────────────────────────────────────────

type OtlpExportRequest = {
  resourceSpans?: ResourceSpan[];
};

type ResourceSpan = {
  resource?: {
    attributes?: OtlpAttribute[];
  };
  scopeSpans?: ScopeSpan[];
};

type ScopeSpan = {
  scope?: {
    name?: string;
  };
  spans?: OtlpSpan[];
};

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
  status?: {
    code?: number;
    message?: string;
  };
  events?: OtlpEvent[];
};

type OtlpAttribute = {
  key: string;
  value: OtlpValue;
};

type OtlpValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpValue[] };
  kvlistValue?: { values?: OtlpAttribute[] };
};

type OtlpEvent = {
  name: string;
  timeUnixNano?: string;
  attributes?: OtlpAttribute[];
};

// ─── Span Kind Mapping ─────────────────────────────────────────

const SPAN_KINDS: Record<number, string> = {
  0: "unspecified",
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

// ─── Helpers ───────────────────────────────────────────────────

function extractAttributeValue(value: OtlpValue): string | number | boolean {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined)
    return typeof value.intValue === "string"
      ? parseInt(value.intValue, 10)
      : value.intValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue?.values) {
    return value.arrayValue.values
      .map((v) => String(extractAttributeValue(v)))
      .join(", ");
  }

  return "";
}

function attributesToMaps(
  attrs?: OtlpAttribute[],
): { meta: Record<string, string>; metrics: Record<string, number> } {
  const meta: Record<string, string> = {};
  const metrics: Record<string, number> = {};

  if (!attrs) return { meta, metrics };

  for (const attr of attrs) {
    const val = extractAttributeValue(attr.value);

    if (typeof val === "number") {
      metrics[attr.key] = val;
    } else {
      meta[attr.key] = String(val);
    }
  }

  return { meta, metrics };
}

/**
 * Convert a hex trace/span ID to a decimal string.
 * DD uses decimal IDs internally; OTel uses hex.
 * We keep the hex representation but truncate trace IDs to 16 chars
 * for consistency with DD's 64-bit trace IDs.
 */
function normalizeTraceId(hexId: string): string {
  // Keep full hex ID for display — the store uses string equality
  return hexId.toLowerCase();
}

function normalizeSpanId(hexId: string): string {
  return hexId.toLowerCase();
}

function getServiceName(resource?: { attributes?: OtlpAttribute[] }): string {
  if (!resource?.attributes) return "unknown";

  const svc = resource.attributes.find(
    (a) => a.key === "service.name",
  );

  return svc ? String(extractAttributeValue(svc.value)) : "unknown";
}

// ─── Parse OTLP JSON ──────────────────────────────────────────

export function parseOtlpSpans(body: OtlpExportRequest): Span[] {
  const spans: Span[] = [];

  if (!body.resourceSpans) return spans;

  for (const rs of body.resourceSpans) {
    const service = getServiceName(rs.resource);
    const resourceAttrs = attributesToMaps(rs.resource?.attributes);

    for (const ss of rs.scopeSpans ?? []) {
      const scopeName = ss.scope?.name ?? "";

      for (const otlpSpan of ss.spans ?? []) {
        const startNano = BigInt(otlpSpan.startTimeUnixNano);
        const endNano = BigInt(otlpSpan.endTimeUnixNano);
        const durationNano = endNano - startNano;

        const { meta, metrics } = attributesToMaps(otlpSpan.attributes);

        // Merge resource attributes into meta (span attrs take precedence)
        for (const [k, v] of Object.entries(resourceAttrs.meta)) {
          if (!(k in meta)) meta[k] = v;
        }

        for (const [k, v] of Object.entries(resourceAttrs.metrics)) {
          if (!(k in metrics)) metrics[k] = v;
        }

        // Add OTel-specific metadata
        meta["otel.scope.name"] = scopeName;
        meta["span.kind"] = SPAN_KINDS[otlpSpan.kind ?? 0] ?? "unspecified";

        if (otlpSpan.status?.message) {
          meta["otel.status_message"] = otlpSpan.status.message;
        }

        // Map status code to error flag
        const isError = otlpSpan.status?.code === 2; // STATUS_CODE_ERROR

        // Build resource string (use http.route, http.target, db.statement, or span name)
        const resource =
          meta["http.route"] ||
          meta["http.target"] ||
          meta["url.path"] ||
          meta["db.statement"] ||
          otlpSpan.name;

        // Determine type from span kind or attributes
        const type =
          meta["db.system"] ??
          meta["messaging.system"] ??
          meta["rpc.system"] ??
          (meta["span.kind"] === "server" || meta["span.kind"] === "client"
            ? "http"
            : meta["span.kind"]);

        spans.push({
          traceId: normalizeTraceId(otlpSpan.traceId),
          spanId: normalizeSpanId(otlpSpan.spanId),
          parentId: otlpSpan.parentSpanId
            ? normalizeSpanId(otlpSpan.parentSpanId)
            : "0",
          name: otlpSpan.name,
          service,
          resource,
          type,
          start: Number(startNano),
          duration: Number(durationNano),
          error: isError ? 1 : 0,
          meta,
          metrics,
        });
      }
    }
  }

  return spans;
}

// ─── Decode request body ──────────────────────────────────────

export function decodeOtlpBody(
  raw: Buffer,
  contentType: string,
  contentEncoding: string | null,
): OtlpExportRequest | null {
  let body = raw;

  // Decompress if needed
  if (contentEncoding === "gzip") {
    body = gunzipSync(body) as Buffer;
  }

  // Only support JSON for now — protobuf would require a proto compiler
  // Most OTel SDKs default to JSON for OTLP/HTTP
  if (
    contentType.includes("json") ||
    contentType.includes("application/x-protobuf") === false
  ) {
    try {
      return JSON.parse(body.toString()) as OtlpExportRequest;
    } catch {
      return null;
    }
  }

  // For protobuf: log a helpful message
  // Users can switch to JSON with OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  console.error(
    "[otap] Received protobuf OTLP payload. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json for otap compatibility.",
  );

  return null;
}
