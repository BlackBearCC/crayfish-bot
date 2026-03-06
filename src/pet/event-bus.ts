/**
 * Pet Engine — EventBus
 *
 * Typed event bus for pet engine subsystems.
 * Replaces per-system callback arrays with a unified pub/sub mechanism.
 */

export type PetEventMap = {
  /** Attribute value crossed a level boundary */
  'attribute:level-change': { key: string; level: string; value: number; prev: string };
  /** Growth stage advanced */
  'growth:stage-up': { stage: number; name: string; prevStage: number };
  /** Epiphany triggered in a domain */
  'skill:epiphany': { domainName: string; recentTopics: string[] };
  /** Attribute XP level up */
  'skill:attr-level-up': { key: string; name: string; level: number };
  /** Tick completed */
  'tick': { deltaMs: number };
  /** Pet interaction received */
  'interact': { action: string; payload?: Record<string, unknown> };
};

type EventHandler<T> = (data: T) => void;

export class EventBus {
  private _handlers = new Map<string, Set<EventHandler<unknown>>>();

  on<K extends keyof PetEventMap>(event: K, handler: EventHandler<PetEventMap[K]>): () => void {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    const set = this._handlers.get(event)!;
    set.add(handler as EventHandler<unknown>);
    return () => set.delete(handler as EventHandler<unknown>);
  }

  emit<K extends keyof PetEventMap>(event: K, data: PetEventMap[K]): void {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (e) {
        console.error(`[pet:event-bus] handler error for "${event}":`, e);
      }
    }
  }

  off<K extends keyof PetEventMap>(event: K, handler: EventHandler<PetEventMap[K]>): void {
    this._handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  removeAll(): void {
    this._handlers.clear();
  }
}
