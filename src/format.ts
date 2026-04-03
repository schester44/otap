export function formatDuration(nanos: number): string {
  if (nanos < 1_000) return `${nanos}ns`;
  if (nanos < 1_000_000) return `${(nanos / 1_000).toFixed(1)}µs`;
  if (nanos < 1_000_000_000) return `${(nanos / 1_000_000).toFixed(1)}ms`;
  return `${(nanos / 1_000_000_000).toFixed(2)}s`;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1_000) return "now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / 3_600_000)}h`;
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + "…";
}

export function padRight(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + " ".repeat(len - str.length);
}

export function padLeft(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return " ".repeat(len - str.length) + str;
}
