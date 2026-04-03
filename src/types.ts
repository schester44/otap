export type Span = {
  traceId: string;
  spanId: string;
  parentId: string;
  name: string;
  service: string;
  resource: string;
  type: string;
  start: number; // nanoseconds
  duration: number; // nanoseconds
  error: number;
  meta: Record<string, string>;
  metrics: Record<string, number>;
};

export type Trace = {
  traceId: string;
  spans: Span[];
  rootSpan: Span | null;
  service: string;
  receivedAt: number;
};

export type SentryError = {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: StackFrame[];
      };
    }>;
  };
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  platform?: string;
  environment?: string;
  release?: string;
  breadcrumbs?: {
    values?: Array<{
      timestamp?: number;
      category?: string;
      message?: string;
      data?: unknown;
    }>;
  };
  stacktrace?: { frames?: StackFrame[] };
  receivedAt: number;
};

export type StackFrame = {
  filename?: string;
  abs_path?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
};

export type ServerMessage =
  | { type: "init"; data: { traces: Trace[]; errors: SentryError[] } }
  | { type: "traces"; data: { spans: Span[] } }
  | { type: "error"; data: { error: SentryError } }
  | { type: "clear"; data: Record<string, never> };
