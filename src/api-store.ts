/**
 * Server-side store that mirrors what the TUI sees.
 * Maintained by subscribing to the event bus — queryable via the HTTP API.
 */
import type { Trace, Span, SentryError } from "./types.js";
import { bus } from "./events.js";

const MAX_TRACES = 500;
const MAX_ERRORS = 500;

const traces = new Map<string, Trace>();
const traceOrder: string[] = [];
const errors: SentryError[] = [];

bus.on("spans", (spans: Span[]) => {
  for (const span of spans) {
    if (!traces.has(span.traceId)) {
      const trace: Trace = {
        traceId: span.traceId,
        spans: [],
        rootSpan: null,
        service: span.service,
        receivedAt: Date.now(),
      };
      traces.set(span.traceId, trace);
      traceOrder.unshift(span.traceId);

      while (traceOrder.length > MAX_TRACES) {
        const old = traceOrder.pop()!;
        traces.delete(old);
      }
    }

    const trace = traces.get(span.traceId)!;
    trace.spans.push(span);
    if (span.parentId === "0" || !span.parentId) {
      trace.rootSpan = span;
      trace.service = span.service;
    }
  }
});

bus.on("error", (error: SentryError) => {
  errors.unshift(error);
  if (errors.length > MAX_ERRORS) errors.pop();
});

// ─── Query functions ─────────────────────────────────────────────

export function getTraces(options?: {
  service?: string;
  limit?: number;
}): Trace[] {
  let result: Trace[] = [];
  for (const id of traceOrder) {
    const trace = traces.get(id);
    if (!trace) continue;
    if (options?.service && trace.service !== options.service) continue;
    result.push(trace);
    if (options?.limit && result.length >= options.limit) break;
  }
  return result;
}

export function getTrace(traceId: string): Trace | null {
  return traces.get(traceId) ?? null;
}

export function getErrors(options?: {
  level?: string;
  limit?: number;
}): SentryError[] {
  let result = errors;
  if (options?.level) {
    result = result.filter((e) => e.level === options.level);
  }
  if (options?.limit) {
    result = result.slice(0, options.limit);
  }
  return result;
}

export function getServices(): string[] {
  const services = new Set<string>();
  for (const trace of traces.values()) {
    if (trace.service) services.add(trace.service);
  }
  return Array.from(services).sort();
}

export function getSummary(): {
  traceCount: number;
  errorCount: number;
  services: string[];
  spanCount: number;
} {
  let spanCount = 0;
  for (const trace of traces.values()) {
    spanCount += trace.spans.length;
  }
  return {
    traceCount: traces.size,
    errorCount: errors.length,
    services: getServices(),
    spanCount,
  };
}

export function clear(): void {
  traces.clear();
  traceOrder.length = 0;
  errors.length = 0;
}
