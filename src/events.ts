import type { Span, SentryError } from "./types.js";

type EventMap = {
  spans: Span[];
  error: SentryError;
  log: { source: "dd" | "sentry"; msg: string };
};

type Listener<K extends keyof EventMap> = (data: EventMap[K]) => void;

class EventBus {
  private listeners = new Map<string, Set<Function>>();

  on<K extends keyof EventMap>(event: K, fn: Listener<K>) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  off<K extends keyof EventMap>(event: K, fn: Listener<K>) {
    this.listeners.get(event)?.delete(fn);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]) {
    for (const fn of this.listeners.get(event) ?? []) {
      fn(data);
    }
  }
}

export const bus = new EventBus();
