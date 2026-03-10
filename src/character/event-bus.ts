/**
 * Character Engine — EventBus
 *
 * Typed event bus for character engine subsystems.
 * Replaces per-system callback arrays with a unified pub/sub mechanism.
 */

export type CharacterEventMap = {
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
  /** Character interaction received */
  'interact': { action: string; payload?: Record<string, unknown> };
  /** Character leveled up */
  'level:up': { level: number; prevLevel: number; title: string };
  /** EXP gained */
  'level:exp-gain': { amount: number; source: string; totalExp: number };
  /** Chat intent evaluated by LLM */
  'chat:eval': { intent: string; moodDelta: number; intimacyDelta: number; streak: number };
  /** Inventory item used */
  'inventory:use': { itemId: string; effects: Record<string, number> };
  /** Daily task completed */
  'daily:task-complete': { taskId: string; difficulty: string };
  /** Daily task reward claimed */
  'daily:task-claim': { taskId: string; reward: { exp: number; coins: number; items: Array<{ id: string; qty: number }> } };
  /** Care action performed */
  'care:action': { action: string; effects: Record<string, number> };
  /** Rest started */
  'care:rest-start': { type: string; durationMs: number; endsAt: number };
  /** Rest ended */
  'care:rest-end': { type: string; effects: Record<string, number> };
  /** Login streak updated */
  'login:streak': { streak: number; date: string };
  /** Coins earned */
  'shop:coin-earn': { amount: number; source: string; balance: number };
  /** Item purchased from shop */
  'shop:buy': { itemId: string; qty: number; totalCost: number; balance: number };
  /** Chat message count hit a round interval (every N messages) */
  'chat:interval': { count: number; interval: number };
  /** Soul Agent decided on an action */
  'soul:action': { type: string; text?: string; careAction?: string; emotion?: string; memory?: { fact: string; category: string } };
  /** World Agent generated an event */
  'world:event': { id: string; type: string; title: string; desc: string };
  /** Todo created */
  'todo:created': { todo: { id: string; title: string; category: string } };
  /** Todo completed by user */
  'todo:completed': { todo: { id: string; title: string; category: string } };
  /** Todo verified by AI */
  'todo:verified': { todo: { id: string; title: string; category: string }; rewards: { exp?: number; coins?: number } };
  /** Todo deleted */
  'todo:deleted': { todo: { id: string; title: string } };
  /** Todos regenerated */
  'todo:regenerated': { cleared: number };
  /** Adventure started */
  'adventure:started': { adventure: { id: string; location: string; type: string; duration: number } };
  /** Adventure choice made */
  'adventure:choice': { adventure: { id: string }; choiceId: string };
  /** Adventure completed */
  'adventure:completed': { adventure: { id: string }; result: { success: boolean; narrative: string } };
  /** Adventure cancelled */
  'adventure:cancelled': { adventure: { id: string } };
};

type EventHandler<T> = (data: T) => void;

export class EventBus {
  private _handlers = new Map<string, Set<EventHandler<unknown>>>();

  on<K extends keyof CharacterEventMap>(event: K, handler: EventHandler<CharacterEventMap[K]>): () => void {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    const set = this._handlers.get(event)!;
    set.add(handler as EventHandler<unknown>);
    return () => set.delete(handler as EventHandler<unknown>);
  }

  emit<K extends keyof CharacterEventMap>(event: K, data: CharacterEventMap[K]): void {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (e) {
        console.error(`[character:event-bus] handler error for "${event}":`, e);
      }
    }
  }

  off<K extends keyof CharacterEventMap>(event: K, handler: EventHandler<CharacterEventMap[K]>): void {
    this._handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  removeAll(): void {
    this._handlers.clear();
  }
}
