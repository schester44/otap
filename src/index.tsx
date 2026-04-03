import { createCliRenderer, TextAttributes } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { Trace, Span, SentryError } from "./types.js";
import { createStore, mergeSpans, addError, type Store } from "./store.js";
import { formatDuration, timeAgo, truncate, padRight, padLeft } from "./format.js";
import { startServers, type Servers } from "./server.js";
import { bus } from "./events.js";

// ─── Config ────────────────────────────────────────────────────────

const DD_PORT = parseInt(process.env.DD_PORT || "8126", 10);
const SENTRY_PORT = parseInt(process.env.SENTRY_PORT || "8137", 10);

// ─── Service Colors ────────────────────────────────────────────────

const SERVICE_COLORS = [
  "#f0883e", "#58a6ff", "#3fb950", "#bc8cff", "#d29922",
  "#f778ba", "#79c0ff", "#56d364", "#d2a8ff", "#e3b341",
];
const serviceColorMap = new Map<string, string>();
function getServiceColor(service: string): string {
  if (!serviceColorMap.has(service)) {
    serviceColorMap.set(service, SERVICE_COLORS[serviceColorMap.size % SERVICE_COLORS.length]);
  }
  return serviceColorMap.get(service)!;
}

// ─── Span Tree ─────────────────────────────────────────────────────

type OrderedSpan = { span: Span; depth: number };

function buildSpanTree(spans: Span[]): OrderedSpan[] {
  const childMap = new Map<string | null, Span[]>();
  const spanMap = new Map<string, Span>();
  for (const s of spans) {
    spanMap.set(s.spanId, s);
    const pid = s.parentId === "0" || !s.parentId ? null : s.parentId;
    if (!childMap.has(pid)) childMap.set(pid, []);
    childMap.get(pid)!.push(s);
  }

  const ordered: OrderedSpan[] = [];
  function dfs(parentId: string | null, depth: number) {
    const children = childMap.get(parentId) || [];
    children.sort((a, b) => a.start - b.start);
    for (const child of children) {
      ordered.push({ span: child, depth });
      dfs(child.spanId, depth + 1);
    }
  }

  const roots = spans.filter(
    (s) => !s.parentId || s.parentId === "0" || !spanMap.has(s.parentId),
  );
  roots.sort((a, b) => a.start - b.start);
  for (const r of roots) {
    ordered.push({ span: r, depth: 0 });
    dfs(r.spanId, 1);
  }
  if (ordered.length === 0) {
    for (const s of spans) ordered.push({ span: s, depth: 0 });
  }
  return ordered;
}

// ─── Bar Rendering ─────────────────────────────────────────────────

function renderBar(offsetPct: number, widthPct: number, cols: number): string {
  const start = Math.floor((offsetPct / 100) * cols);
  const barCols = Math.max(Math.round((widthPct / 100) * cols), 1);
  let out = "";
  for (let i = 0; i < cols; i++) {
    if (i >= start && i < start + barCols) out += "█";
    else out += " ";
  }
  return out;
}

// ─── Duration Color ────────────────────────────────────────────────

function durationColor(nanos: number): string {
  const ms = nanos / 1_000_000;
  if (ms > 1000) return "#f85149";
  if (ms > 200) return "#d29922";
  return "#3fb950";
}

// ─── App ───────────────────────────────────────────────────────────

function App({ servers }: { servers: Servers }) {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();

  const [store, setStore] = useState<Store>(createStore);
  const [tab, setTab] = useState<"traces" | "errors">("traces");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailScroll, setDetailScroll] = useState(0);
  const [selectedSpanIndex, setSelectedSpanIndex] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [serviceFilter, setServiceFilter] = useState<string | null>(null); // null = all
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // Collect unique services
  const services = Array.from(
    new Set(store.traces.map((t) => t.service).filter(Boolean)),
  ).sort();

  // Filtered data
  const filteredTraces = serviceFilter
    ? store.traces.filter((t) => t.service === serviceFilter)
    : store.traces;
  const filteredErrors = serviceFilter
    ? store.errors.filter((e) => e.tags?.service === serviceFilter || !serviceFilter)
    : store.errors;

  // Subscribe to server events
  useEffect(() => {
    const onSpans = (spans: Span[]) => {
      if (pausedRef.current) return;
      setStore((prev) => mergeSpans(prev, spans));
    };
    const onError = (error: SentryError) => {
      if (pausedRef.current) return;
      setStore((prev) => addError(prev, error));
    };

    bus.on("spans", onSpans);
    bus.on("error", onError);

    return () => {
      bus.off("spans", onSpans);
      bus.off("error", onError);
    };
  }, []);

  // Keyboard
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      servers.stop();
      renderer.destroy();
      process.exit(0);
    }

    const list = tab === "traces" ? filteredTraces : filteredErrors;
    const maxIdx = Math.max(0, list.length - 1);

    switch (key.name) {
      case "tab":
        setTab((t) => (t === "traces" ? "errors" : "traces"));
        setSelectedIndex(0);
        setDetailScroll(0);
        break;
      case "s":
        // Cycle through: all → service1 → service2 → … → all
        setServiceFilter((current) => {
          if (services.length === 0) return null;
          if (current === null) return services[0];
          const idx = services.indexOf(current);
          if (idx === -1 || idx === services.length - 1) return null;
          return services[idx + 1];
        });
        setSelectedIndex(0);
        setDetailScroll(0);
        break;
      case "S":
        // Reverse cycle
        setServiceFilter((current) => {
          if (services.length === 0) return null;
          if (current === null) return services[services.length - 1];
          const idx = services.indexOf(current);
          if (idx <= 0) return null;
          return services[idx - 1];
        });
        setSelectedIndex(0);
        setDetailScroll(0);
        break;
      case "up":
      case "k":
        if (selectedSpanIndex !== null) {
          setSelectedSpanIndex((i) => Math.max(0, (i ?? 0) - 1));
          setDetailScroll(0);
        } else {
          setSelectedIndex((i) => Math.max(0, i - 1));
          setDetailScroll(0);
        }
        break;
      case "down":
      case "j":
        if (selectedSpanIndex !== null) {
          const trace = tab === "traces" ? filteredTraces[selectedIndex] : null;
          const spanMax = trace ? Math.max(0, trace.spans.length - 1) : 0;
          setSelectedSpanIndex((i) => Math.min(spanMax, (i ?? 0) + 1));
          setDetailScroll(0);
        } else {
          setSelectedIndex((i) => Math.min(maxIdx, i + 1));
          setDetailScroll(0);
        }
        break;
      case "return":
        if (tab === "traces" && selectedSpanIndex === null) {
          setSelectedSpanIndex(0);
          setDetailScroll(0);
        }
        break;
      case "escape":
        if (selectedSpanIndex !== null) {
          setSelectedSpanIndex(null);
          setDetailScroll(0);
        }
        break;
      case "left":
      case "h":
        setDetailScroll((s) => Math.max(0, s - 1));
        break;
      case "right":
      case "l":
        setDetailScroll((s) => s + 1);
        break;
      case "pageup":
        setSelectedIndex((i) => Math.max(0, i - 10));
        setDetailScroll(0);
        break;
      case "pagedown":
        setSelectedIndex((i) => Math.min(maxIdx, i + 10));
        setDetailScroll(0);
        break;
      case "home":
      case "g":
        setSelectedIndex(0);
        setDetailScroll(0);
        break;
      case "end":
        setSelectedIndex(maxIdx);
        setDetailScroll(0);
        break;
      case "space":
        setPaused((p) => !p);
        break;
      case "x":
        setStore(createStore);
        setSelectedIndex(0);
        setDetailScroll(0);
        break;
    }
  });

  // ─── Layout ────────────────────────────────────────────────────

  const W = dims.width;
  const H = dims.height;
  const listW = Math.min(Math.max(Math.floor(W * 0.35), 30), 55);
  const detailW = W - listW - 1;
  const headerH = 3; // logo + tabs + divider
  const helpH = 1;
  const bodyH = H - headerH - helpH;

  const traces = filteredTraces;
  const errors = filteredErrors;
  const selectedTrace = tab === "traces" ? traces[selectedIndex] ?? null : null;
  const selectedError = tab === "errors" ? errors[selectedIndex] ?? null : null;

  return (
    <box style={{ height: H, width: W, backgroundColor: "#0d1117", flexDirection: "column" }}>

      {/* Header */}
      <box style={{ height: 1, flexDirection: "row", backgroundColor: "#161b22" }}>
        <text style={{ fg: "#3fb950" }}>{"● "}</text>
        <text attributes={TextAttributes.BOLD} style={{ fg: "#e6edf3" }}>OTAP</text>
        <text style={{ fg: "#30363d" }}>{" │ "}</text>
        {serviceFilter ? (
          <text style={{ fg: getServiceColor(serviceFilter) }}>{"⏺ " + serviceFilter}</text>
        ) : (
          <text style={{ fg: "#6e7681" }}>{services.length > 0 ? "all services (" + services.length + ")" : "no services"}</text>
        )}
        {paused ? <text style={{ fg: "#d29922" }}>{"  ⏸ PAUSED"}</text> : null}
      </box>

      {/* Tab bar + service pills */}
      <box style={{ height: 1, flexDirection: "row", backgroundColor: "#161b22" }}>
        <text style={{ fg: tab === "traces" ? "#f0883e" : "#6e7681" }}>
          {tab === "traces" ? " ▸ " : "   "}TRACES ({traces.length})
        </text>
        <text style={{ fg: "#30363d" }}>{" │ "}</text>
        <text style={{ fg: tab === "errors" ? "#f85149" : "#6e7681" }}>
          {tab === "errors" ? " ▸ " : "   "}ERRORS ({errors.length})
        </text>
        <text style={{ fg: "#30363d" }}>{" │ "}</text>
        {services.map((svc) => (
          <text key={svc} style={{ fg: svc === serviceFilter ? getServiceColor(svc) : "#484f58" }}>
            {" " + svc}
          </text>
        ))}
      </box>

      {/* Divider */}
      <box style={{ height: 1 }}>
        <text style={{ fg: "#30363d" }}>{"─".repeat(W)}</text>
      </box>

      {/* Body */}
      <box style={{ height: bodyH, flexDirection: "row" }}>

        {/* List */}
        <box style={{ width: listW, flexDirection: "column" }}>
          {tab === "traces" ? (
            <TraceListView traces={traces} selectedIndex={selectedIndex} height={bodyH} width={listW} />
          ) : (
            <ErrorListView errors={errors} selectedIndex={selectedIndex} height={bodyH} width={listW} />
          )}
        </box>

        {/* Vertical divider */}
        <box style={{ width: 1 }}>
          {Array.from({ length: bodyH }).map((_, i) => (
            <text key={i} style={{ fg: "#30363d" }}>{"│"}</text>
          ))}
        </box>

        {/* Detail */}
        <box style={{ width: detailW, flexDirection: "column" }}>
          {tab === "traces" && selectedTrace ? (
            <TraceDetailView trace={selectedTrace} width={detailW} height={bodyH} scrollOffset={detailScroll} selectedSpanIndex={selectedSpanIndex} />
          ) : tab === "errors" && selectedError ? (
            <ErrorDetailView error={selectedError} width={detailW} height={bodyH} scrollOffset={detailScroll} />
          ) : (
            <box style={{ padding: 2 }}>
              <text style={{ fg: "#484f58" }}>{"◇ Select an item to view details"}</text>
            </box>
          )}
        </box>
      </box>

      {/* Help */}
      <box style={{ height: helpH, backgroundColor: "#161b22", flexDirection: "row" }}>
        <text style={{ fg: "#484f58" }}>{" ↑↓"}</text>
        <text style={{ fg: "#6e7681" }}>{" nav "}</text>
        <text style={{ fg: "#484f58" }}>{"enter"}</text>
        <text style={{ fg: "#6e7681" }}>{" inspect "}</text>
        <text style={{ fg: "#484f58" }}>{"esc"}</text>
        <text style={{ fg: "#6e7681" }}>{" back "}</text>
        <text style={{ fg: "#484f58" }}>{"tab"}</text>
        <text style={{ fg: "#6e7681" }}>{" switch "}</text>
        <text style={{ fg: "#484f58" }}>{"s"}</text>
        <text style={{ fg: "#6e7681" }}>{" service "}</text>
        <text style={{ fg: "#484f58" }}>{"←→"}</text>
        <text style={{ fg: "#6e7681" }}>{" scroll "}</text>
        <text style={{ fg: "#484f58" }}>{"space"}</text>
        <text style={{ fg: "#6e7681" }}>{" pause "}</text>
        <text style={{ fg: "#484f58" }}>{"x"}</text>
        <text style={{ fg: "#6e7681" }}>{" clear "}</text>
        <text style={{ fg: "#484f58" }}>{"^c"}</text>
        <text style={{ fg: "#6e7681" }}>{" quit"}</text>
      </box>
    </box>
  );
}

// ─── Trace List ──────────────────────────────────────────────────

function TraceListView({ traces, selectedIndex, height, width }: {
  traces: Trace[]; selectedIndex: number; height: number; width: number;
}) {
  if (traces.length === 0) {
    return (
      <box style={{ padding: 1, flexDirection: "column" }}>
        <text style={{ fg: "#484f58" }}>{"◇ Waiting for traces…"}</text>
        <text style={{ fg: "#30363d" }}>{"  dd-trace → :" + DD_PORT}</text>
      </box>
    );
  }

  const itemH = 2;
  const visibleCount = Math.floor(height / itemH);
  let scrollStart = 0;
  if (selectedIndex >= visibleCount) {
    scrollStart = selectedIndex - visibleCount + 1;
  }
  const visible = traces.slice(scrollStart, scrollStart + visibleCount);

  return (
    <box style={{ flexDirection: "column" }}>
      {visible.map((trace, i) => {
        const idx = scrollStart + i;
        const sel = idx === selectedIndex;
        const root = trace.rootSpan;
        const name = root ? truncate(root.resource || root.name, width - 4) : `trace:${trace.traceId.slice(-8)}`;
        const dur = root ? root.duration : trace.spans.reduce((m, s) => Math.max(m, s.duration), 0);
        const hasErr = trace.spans.some((s) => s.error);
        const bg = sel ? "#1c1507" : "transparent";
        const nameFg = hasErr ? "#f85149" : sel ? "#e6edf3" : "#8b949e";

        return (
          <box key={trace.traceId} style={{ height: itemH, backgroundColor: bg }}>
            <box style={{ flexDirection: "row", height: 1 }}>
              <text style={{ fg: sel ? "#f0883e" : "#30363d" }}>{sel ? "▸ " : "  "}</text>
              <text style={{ fg: nameFg }}>{name}</text>
            </box>
            <box style={{ flexDirection: "row", height: 1, paddingLeft: 2 }}>
              <text style={{ fg: "#f0883e" }}>{truncate(trace.service, 14)}</text>
              <text style={{ fg: durationColor(dur) }}>{" " + formatDuration(dur)}</text>
              <text style={{ fg: "#484f58" }}>{" " + trace.spans.length + "sp"}</text>
              {hasErr ? <text style={{ fg: "#f85149" }}>{" ERR"}</text> : null}
              <text style={{ fg: "#30363d" }}>{" " + timeAgo(trace.receivedAt)}</text>
            </box>
          </box>
        );
      })}
    </box>
  );
}

// ─── Trace Detail (Waterfall) ────────────────────────────────────

function TraceDetailView({ trace, width, height, scrollOffset, selectedSpanIndex }: {
  trace: Trace; width: number; height: number; scrollOffset: number; selectedSpanIndex: number | null;
}) {
  const spans = trace.spans;
  const root = trace.rootSpan || spans[0];
  if (!root || spans.length === 0) return <text style={{ fg: "#484f58" }}>No spans</text>;

  const traceStart = Math.min(...spans.map((s) => s.start));
  const traceEnd = Math.max(...spans.map((s) => s.start + s.duration));
  const traceDuration = traceEnd - traceStart;
  const ordered = buildSpanTree(spans);

  const labelW = Math.min(Math.max(Math.floor(width * 0.3), 20), 36);
  const durW = 10;
  const barW = Math.max(width - labelW - durW - 3, 10);

  const mid = formatDuration(Math.round(traceDuration / 2));
  const end = formatDuration(traceDuration);
  const gap = Math.max(barW - 1 - mid.length - end.length, 0);
  const ruler = "0" + " ".repeat(Math.floor(gap / 2)) + mid + " ".repeat(Math.ceil(gap / 2)) + end;

  // Build all content lines: header + waterfall + span detail
  type Line = { fg: string; text: string; bold?: boolean; bg?: string };
  const lines: Line[] = [];

  // Header (3 lines)
  lines.push({ fg: "#e6edf3", text: truncate(root.resource || root.name, width - 2), bold: true });
  lines.push({ fg: "#6e7681", text: trace.service + " · " + spans.length + " spans · " + formatDuration(traceDuration) });
  lines.push({ fg: "#30363d", text: " ".repeat(labelW) + ruler });

  // Waterfall rows
  for (let i = 0; i < ordered.length; i++) {
    const { span, depth } = ordered[i];
    const pct = traceDuration > 0 ? ((span.start - traceStart) / traceDuration) * 100 : 0;
    const wPct = traceDuration > 0 ? Math.max((span.duration / traceDuration) * 100, 0.5) : 100;
    const color = span.error ? "#f85149" : getServiceColor(span.service);
    const indent = depth > 0 ? "│".repeat(Math.min(depth, 6)) + " " : "";
    const maxLabel = labelW - indent.length - 1;
    const label = truncate(span.resource || span.name, Math.max(maxLabel, 5));
    const bar = renderBar(pct, wPct, barW);
    const isSelected = selectedSpanIndex === i;
    const marker = isSelected ? "▸" : " ";

    lines.push({
      fg: color,
      text: marker + indent + padRight(label, maxLabel) + " " + bar + " " + padLeft(formatDuration(span.duration), durW - 1),
      bg: isSelected ? "#1c1507" : undefined,
    });
  }

  // Span detail section (if a span is selected)
  const selectedSpan = selectedSpanIndex !== null ? ordered[selectedSpanIndex]?.span : null;
  if (selectedSpan) {
    lines.push({ fg: "#30363d", text: "─".repeat(width - 2) });
    lines.push({ fg: "#f0883e", text: "SPAN: " + selectedSpan.name, bold: true });
    lines.push({ fg: "#30363d", text: "─".repeat(width - 2) });

    // Core fields
    const fields: [string, string][] = [
      ["service", selectedSpan.service],
      ["resource", selectedSpan.resource],
      ["type", selectedSpan.type],
      ["duration", formatDuration(selectedSpan.duration)],
      ["span_id", selectedSpan.spanId],
      ["trace_id", selectedSpan.traceId],
      ["parent_id", selectedSpan.parentId || "(root)"],
      ["error", selectedSpan.error ? "true" : "false"],
    ];
    for (const [k, v] of fields) {
      lines.push({ fg: "#6e7681", text: "  " + padRight(k, 16) + truncate(v, width - 20) });
    }

    // Meta tags
    const metaEntries = Object.entries(selectedSpan.meta || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (metaEntries.length > 0) {
      lines.push({ fg: "#30363d", text: "─".repeat(width - 2) });
      lines.push({ fg: "#58a6ff", text: "META", bold: true });
      for (const [k, v] of metaEntries) {
        lines.push({ fg: "#8b949e", text: "  " + padRight(k, 28) + truncate(String(v), width - 32) });
      }
    }

    // Metrics
    const metricsEntries = Object.entries(selectedSpan.metrics || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (metricsEntries.length > 0) {
      lines.push({ fg: "#30363d", text: "─".repeat(width - 2) });
      lines.push({ fg: "#3fb950", text: "METRICS", bold: true });
      for (const [k, v] of metricsEntries) {
        lines.push({ fg: "#8b949e", text: "  " + padRight(k, 28) + String(v) });
      }
    }
  } else if (ordered.length > 0) {
    lines.push({ fg: "#30363d", text: "" });
    lines.push({ fg: "#484f58", text: "  enter to inspect span tags" });
  }

  // Render visible slice
  const visibleLines = lines.slice(scrollOffset, scrollOffset + height);

  return (
    <box style={{ flexDirection: "column", paddingLeft: 1 }}>
      {visibleLines.map((line, i) => (
        <text
          key={scrollOffset + i}
          attributes={line.bold ? TextAttributes.BOLD : undefined}
          style={{ fg: line.fg, backgroundColor: line.bg }}
        >
          {line.text}
        </text>
      ))}
      {lines.length > height ? (
        <text style={{ fg: "#30363d" }}>
          {"  ←→ scroll (" + (scrollOffset + 1) + "–" + Math.min(scrollOffset + height, lines.length) + " of " + lines.length + ")"}
        </text>
      ) : null}
    </box>
  );
}

// ─── Error List ──────────────────────────────────────────────────

function ErrorListView({ errors, selectedIndex, height, width }: {
  errors: SentryError[]; selectedIndex: number; height: number; width: number;
}) {
  if (errors.length === 0) {
    return (
      <box style={{ padding: 1, flexDirection: "column" }}>
        <text style={{ fg: "#484f58" }}>{"◇ Waiting for errors…"}</text>
        <text style={{ fg: "#30363d" }}>{"  Sentry → :" + SENTRY_PORT}</text>
      </box>
    );
  }

  const itemH = 2;
  const visibleCount = Math.floor(height / itemH);
  let scrollStart = 0;
  if (selectedIndex >= visibleCount) {
    scrollStart = selectedIndex - visibleCount + 1;
  }
  const visible = errors.slice(scrollStart, scrollStart + visibleCount);

  return (
    <box style={{ flexDirection: "column" }}>
      {visible.map((error, i) => {
        const idx = scrollStart + i;
        const sel = idx === selectedIndex;
        const bg = sel ? "#1a0c0c" : "transparent";
        const levelColor = error.level === "error" || error.level === "fatal" ? "#f85149"
          : error.level === "warning" ? "#d29922" : "#58a6ff";

        return (
          <box key={error.id} style={{ height: itemH, backgroundColor: bg }}>
            <box style={{ flexDirection: "row", height: 1 }}>
              <text style={{ fg: sel ? "#f85149" : "#30363d" }}>{sel ? "▸ " : "  "}</text>
              <text style={{ fg: levelColor }}>{error.level.toUpperCase()}</text>
              <text style={{ fg: "#484f58" }}>{" " + new Date(error.timestamp).toLocaleTimeString()}</text>
            </box>
            <box style={{ height: 1, paddingLeft: 2 }}>
              <text style={{ fg: sel ? "#e6edf3" : "#8b949e" }}>{truncate(error.message, width - 4)}</text>
            </box>
          </box>
        );
      })}
    </box>
  );
}

// ─── Error Detail ────────────────────────────────────────────────

function ErrorDetailView({ error, width, height, scrollOffset }: {
  error: SentryError; width: number; height: number; scrollOffset: number;
}) {
  const levelColor = error.level === "error" || error.level === "fatal" ? "#f85149"
    : error.level === "warning" ? "#d29922" : "#58a6ff";

  const lines: Array<{ fg: string; text: string }> = [];

  lines.push({ fg: levelColor, text: `${error.level.toUpperCase()}: ${error.message}` });
  lines.push({ fg: "#484f58", text: `Timestamp: ${error.timestamp}` });
  if (error.environment) lines.push({ fg: "#484f58", text: `Environment: ${error.environment}` });
  if (error.release) lines.push({ fg: "#484f58", text: `Release: ${error.release}` });
  lines.push({ fg: "#30363d", text: "─".repeat(width - 2) });

  const frames = error.stacktrace?.frames ?? error.exception?.values?.[0]?.stacktrace?.frames;
  if (frames && frames.length > 0) {
    lines.push({ fg: "#e6edf3", text: "Stacktrace:" });
    for (const frame of [...frames].reverse()) {
      const fn = frame.function || "?";
      const file = frame.filename || frame.abs_path || "?";
      const loc = frame.lineno ? `:${frame.lineno}${frame.colno ? ":" + frame.colno : ""}` : "";
      lines.push({ fg: frame.in_app !== false ? "#bc8cff" : "#484f58", text: `  ${fn}  ${file}${loc}` });
    }
    lines.push({ fg: "#30363d", text: "─".repeat(width - 2) });
  }

  if (error.tags && Object.keys(error.tags).length > 0) {
    lines.push({ fg: "#e6edf3", text: "Tags:" });
    for (const [k, v] of Object.entries(error.tags).sort()) {
      lines.push({ fg: "#6e7681", text: `  ${k}: ${v}` });
    }
    lines.push({ fg: "#30363d", text: "─".repeat(width - 2) });
  }

  if (error.contexts) {
    for (const [name, ctx] of Object.entries(error.contexts)) {
      if (typeof ctx !== "object" || ctx === null) continue;
      lines.push({ fg: "#e6edf3", text: `Context: ${name}` });
      for (const [k, v] of Object.entries(ctx).sort()) {
        const val = typeof v === "object" ? JSON.stringify(v) : String(v);
        lines.push({ fg: "#6e7681", text: `  ${k}: ${truncate(val, width - 6)}` });
      }
    }
  }

  const visibleLines = lines.slice(scrollOffset, scrollOffset + height);

  return (
    <box style={{ flexDirection: "column", paddingLeft: 1 }}>
      {visibleLines.map((line, i) => (
        <text key={scrollOffset + i} style={{ fg: line.fg }}>{line.text}</text>
      ))}
      {lines.length > height ? (
        <text style={{ fg: "#30363d" }}>
          {"  ←→ scroll (" + (scrollOffset + 1) + "–" + Math.min(scrollOffset + height, lines.length) + " of " + lines.length + ")"}
        </text>
      ) : null}
    </box>
  );
}

// ─── Bootstrap ───────────────────────────────────────────────────

// Parse --drop flags: e.g. --drop pgboss --drop "SELECT FROM jobs"
const dropPatterns: string[] = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--drop" && process.argv[i + 1]) {
    dropPatterns.push(process.argv[++i]);
  }
}

const servers = startServers({ ddPort: DD_PORT, sentryPort: SENTRY_PORT, dropPatterns });

process.on("SIGINT", () => {
  servers.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  servers.stop();
  process.exit(0);
});

const renderer = await createCliRenderer();
createRoot(renderer).render(<App servers={servers} />);
