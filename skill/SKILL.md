# Skill: otap — Trace & Error Inspection

Use this skill when you need to inspect application traces, spans, or Sentry errors from the local development environment. otap must be running (`tools/otap/bin/otap`).

## Overview

The local-otel tool acts as a fake Datadog agent (port 8126) and Sentry server (port 8137). When the app runs with `DD_API_KEY=local`, all traces and errors flow into it. The tool exposes a JSON API on the same port (8126) that you can query with `curl`.

## Starting otap

```bash
# Basic (pgboss polling is filtered by default)
./tools/otap/bin/otap

# Filter additional noisy spans
./tools/otap/bin/otap --drop health_check
```

## Checking if otap is running

```bash
curl -s http://localhost:8126/api/summary 2>/dev/null || echo "otap is not running"
```

## API Endpoints

All endpoints are on `http://localhost:8126`.

### GET /api/summary

High-level overview — start here.

```bash
curl -s http://localhost:8126/api/summary | python3 -m json.tool
```

Returns:
```json
{
  "traceCount": 42,
  "errorCount": 3,
  "services": ["risk-api", "surefin-worker", "payment-svc"],
  "spanCount": 156
}
```

### GET /api/services

List all discovered services.

```bash
curl -s http://localhost:8126/api/services
```

### GET /api/traces?service=NAME&limit=N

List recent traces. Filter by service name and limit results.

```bash
# All recent traces (default limit: 50)
curl -s http://localhost:8126/api/traces | python3 -m json.tool

# Only traces from risk-api
curl -s "http://localhost:8126/api/traces?service=risk-api&limit=10" | python3 -m json.tool
```

Each trace contains:
- `traceId` — unique trace identifier
- `service` — service name from the root span
- `rootSpan` — the entry-point span (has `resource`, `duration`, `error`, `meta`)
- `spans[]` — all spans in the trace, each with:
  - `name` — operation name (e.g. `express.request`, `pg.query`)
  - `resource` — specific resource (e.g. `POST /graphql`, `SELECT * FROM policies`)
  - `service` — which service produced this span
  - `duration` — in nanoseconds
  - `error` — 0 or 1
  - `meta` — key-value tags (e.g. `http.method`, `db.type`, `http.status_code`)
  - `parentId` — parent span ID for tree reconstruction

### GET /api/traces/:traceId

Get a single trace with all its spans.

```bash
curl -s http://localhost:8126/api/traces/1234567890 | python3 -m json.tool
```

### GET /api/errors?level=LEVEL&limit=N

List recent Sentry errors.

```bash
# All errors
curl -s http://localhost:8126/api/errors | python3 -m json.tool

# Only error-level (not warnings)
curl -s "http://localhost:8126/api/errors?level=error&limit=5" | python3 -m json.tool
```

Each error contains:
- `level` — error, warning, info
- `message` — error message
- `exception.values[]` — exception chain with types and stacktraces
- `stacktrace.frames[]` — stack frames with `filename`, `function`, `lineno`, `in_app`
- `tags` — key-value metadata
- `contexts` — additional context (including Datadog trace correlation)
- `breadcrumbs.values[]` — events leading up to the error

### POST /api/clear

Clear all stored traces and errors.

```bash
curl -s -X POST http://localhost:8126/api/clear
```

## Typical Workflows

### Investigate a slow endpoint

```bash
# 1. See what services are active
curl -s http://localhost:8126/api/summary

# 2. Get recent traces for the API, look for slow ones
curl -s "http://localhost:8126/api/traces?service=risk-api&limit=20" | \
  python3 -c "
import sys, json
traces = json.load(sys.stdin)
for t in traces:
    root = t.get('rootSpan') or {}
    dur_ms = root.get('duration', 0) / 1e6
    resource = root.get('resource', '?')
    spans = len(t.get('spans', []))
    err = ' ERR' if root.get('error') else ''
    print(f'{dur_ms:8.1f}ms  {spans:2d}sp  {resource}{err}')
"

# 3. Drill into a specific slow trace
curl -s http://localhost:8126/api/traces/TRACE_ID | python3 -m json.tool
```

### Check for errors after a code change

```bash
# See if any new errors appeared
curl -s "http://localhost:8126/api/errors?limit=5" | \
  python3 -c "
import sys, json
errors = json.load(sys.stdin)
for e in errors:
    print(f'{e[\"level\"].upper():7s} {e[\"message\"][:80]}')
    frames = (e.get('stacktrace') or {}).get('frames') or \
             (((e.get('exception') or {}).get('values') or [{}])[0].get('stacktrace') or {}).get('frames') or []
    for f in reversed(frames[-3:]):
        if f.get('in_app', True):
            print(f'        {f.get(\"function\",\"?\")}  {f.get(\"filename\",\"?\")}:{f.get(\"lineno\",\"\")}')
"
```

## Duration Units

Span durations are in **nanoseconds**. Quick conversion:
- `÷ 1e6` → milliseconds
- `÷ 1e9` → seconds
