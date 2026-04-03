import type { Trace, Span, SentryError, ServerMessage } from "./types.js";

const MAX_TRACES = 500;
const MAX_ERRORS = 500;

export type Store = {
  traces: Trace[];
  errors: SentryError[];
  connected: boolean;
};

export function createStore(): Store {
  return {
    traces: [],
    errors: [],
    connected: false,
  };
}

export function mergeSpans(store: Store, spans: Span[]): Store {
  const traces = [...store.traces];

  for (const span of spans) {
    let trace = traces.find((t) => t.traceId === span.traceId);
    if (!trace) {
      trace = {
        traceId: span.traceId,
        spans: [],
        rootSpan: null,
        service: span.service,
        receivedAt: Date.now(),
      };
      traces.unshift(trace);
    } else {
      // Clone so React detects the change
      const index = traces.indexOf(trace);
      trace = { ...trace, spans: [...trace.spans] };
      traces[index] = trace;
    }
    trace.spans.push(span);
    if (span.parentId === "0" || !span.parentId) {
      trace.rootSpan = span;
      trace.service = span.service;
    }
  }

  return {
    ...store,
    traces: traces.slice(0, MAX_TRACES),
  };
}

export function addError(store: Store, error: SentryError): Store {
  return {
    ...store,
    errors: [error, ...store.errors].slice(0, MAX_ERRORS),
  };
}

export function clearStore(store: Store): Store {
  return { ...store, traces: [], errors: [] };
}

export function applyMessage(store: Store, msg: ServerMessage): Store {
  switch (msg.type) {
    case "init":
      return { ...store, traces: msg.data.traces, errors: msg.data.errors };
    case "traces":
      return mergeSpans(store, msg.data.spans);
    case "error":
      return addError(store, msg.data.error);
    case "clear":
      return clearStore(store);
  }
}
