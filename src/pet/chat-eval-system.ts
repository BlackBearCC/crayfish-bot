/**
 * Pet Engine — ChatEvalSystem
 *
 * Two-layer system for chat-driven state changes:
 *
 * Layer 1: Fixed program values (per-interaction, immediate)
 *   - click, longpress, feed, chat etc. handled by PetEngine.interact()
 *
 * Layer 2: LLM intent extraction (every 5 user messages, min 5min interval)
 *   - LLM analyzes recent conversation → outputs intent label
 *   - Program looks up intent → applies effects with streak multiplier
 *
 * Also manages:
 *   - Chat hunger consumption (-10 per user message)
 *   - Tool call hunger consumption (-1 per tool call)
 *   - Chat gate (refuse when hunger <= 30)
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import type { AttributeEngine } from "./attribute-engine.js";
import type { GrowthSystem } from "./growth-system.js";
import type { LevelSystem } from "./level-system.js";

// ─── Intent types ───

export type ChatIntent =
  | "praise"
  | "deep_talk"
  | "playful"
  | "gratitude"
  | "cold"
  | "impatient"
  | "angry"
  | "sad_share"
  | "neutral";

export const INTENT_EFFECTS: Record<ChatIntent, { mood: number; intimacy: number }> = {
  praise:     { mood: 5,  intimacy: 3 },
  deep_talk:  { mood: 3,  intimacy: 5 },
  playful:    { mood: 6,  intimacy: 2 },
  gratitude:  { mood: 4,  intimacy: 4 },
  cold:       { mood: -2, intimacy: 0 },
  impatient:  { mood: -4, intimacy: -1 },
  angry:      { mood: -6, intimacy: -2 },
  sad_share:  { mood: -1, intimacy: 4 },
  neutral:    { mood: 1,  intimacy: 1 },
};

const ALL_INTENTS = new Set(Object.keys(INTENT_EFFECTS));

// ─── Constants ───

export const CHAT_HUNGER_COST = 10;
export const TOOL_HUNGER_COST = 1;
export const MIN_HUNGER_TO_CHAT = 30;
const EVAL_INTERVAL_MESSAGES = 5;
const EVAL_MIN_INTERVAL_MS = 5 * 60 * 1000;

// ─── Streak multiplier (quadratic) ───

export function streakMultiplier(streak: number): number {
  if (streak <= 1) return 1.0;
  return Math.min(3.0, 1 + 0.15 * Math.pow(streak - 1, 2));
}

// ─── LLM evaluation prompt ───

export const EVAL_PROMPT_TEMPLATE = `你是对话意图分类器。根据最近的对话内容，从预定义类别中选择最匹配的意图。

预定义意图:
- praise: 用户夸奖、肯定、说"你真棒"等
- deep_talk: 深度交流、情感倾诉、谈心事
- playful: 调皮、玩闹、开玩笑
- gratitude: 表达感谢
- cold: 冷漠、敷衍、纯指令式对话(如"翻译这段""总结一下")
- impatient: 不耐烦、催促、"快点""怎么这么慢"
- angry: 骂人、发火、攻击性语言
- sad_share: 用户分享负面情绪(难过/焦虑)，但信任宠物愿意倾诉
- neutral: 普通工作对话，无明显情感倾向

最近对话:
{recentMessages}

只输出 JSON:
{"intent": "<意图标签>"}`;

// ─── Persistence ───

interface ChatEvalState {
  msgCount: number;
  lastEvalAt: number;
  streak: number;
  lastDirection: "positive" | "negative" | null;
  recentMessages: string[];
}

const STORE_KEY = "chat-eval";
const MAX_RECENT_MESSAGES = 20;

// ─── Callback type for LLM calls ───

export type LLMEvalCallback = (prompt: string) => Promise<{ intent: string }>;

// ─── System ───

export class ChatEvalSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _attributes: AttributeEngine;
  private _growth: GrowthSystem;
  private _levels: LevelSystem;
  private _msgCount: number = 0;
  private _lastEvalAt: number = 0;
  private _streak: number = 0;
  private _lastDirection: "positive" | "negative" | null = null;
  private _recentMessages: string[] = [];
  private _llmEval: LLMEvalCallback | null = null;

  constructor(
    bus: EventBus,
    store: PersistenceStore,
    attributes: AttributeEngine,
    growth: GrowthSystem,
    levels: LevelSystem,
  ) {
    this._bus = bus;
    this._store = store;
    this._attributes = attributes;
    this._growth = growth;
    this._levels = levels;

    const saved = this._store.load(STORE_KEY) as ChatEvalState | null;
    if (saved) {
      this._msgCount = saved.msgCount ?? 0;
      this._lastEvalAt = saved.lastEvalAt ?? 0;
      this._streak = saved.streak ?? 0;
      this._lastDirection = saved.lastDirection ?? null;
      this._recentMessages = saved.recentMessages ?? [];
    }
  }

  /** Register the LLM evaluation callback (set by gateway) */
  setLLMEval(callback: LLMEvalCallback): void {
    this._llmEval = callback;
  }

  /** Check if pet has enough hunger to chat */
  canChat(): { ok: boolean; hunger: number; minRequired: number } {
    const hunger = this._attributes.getValue("hunger");
    return {
      ok: hunger > MIN_HUNGER_TO_CHAT,
      hunger: Math.round(hunger),
      minRequired: MIN_HUNGER_TO_CHAT,
    };
  }

  /**
   * Called when user sends a chat message.
   * Handles hunger consumption, message caching, and eval triggering.
   */
  onUserMessage(messageText: string): { ok: boolean; reason?: string } {
    // Check hunger gate
    const hunger = this._attributes.getValue("hunger");
    if (hunger <= MIN_HUNGER_TO_CHAT) {
      return { ok: false, reason: "too_hungry" };
    }

    // Consume hunger
    this._attributes.adjust("hunger", -CHAT_HUNGER_COST);

    // Cache message for LLM eval
    this._recentMessages.push(`用户: ${messageText}`);
    if (this._recentMessages.length > MAX_RECENT_MESSAGES) {
      this._recentMessages = this._recentMessages.slice(-MAX_RECENT_MESSAGES);
    }

    // Increment count
    this._msgCount++;

    // Check eval trigger (dual condition)
    if (this._msgCount % EVAL_INTERVAL_MESSAGES === 0) {
      if (Date.now() - this._lastEvalAt >= EVAL_MIN_INTERVAL_MS) {
        this._triggerEval();
      }
    }

    this._save();
    return { ok: true };
  }

  /** Called when assistant sends a reply (for context in eval) */
  onAssistantMessage(messageText: string): void {
    this._recentMessages.push(`宠物: ${messageText}`);
    if (this._recentMessages.length > MAX_RECENT_MESSAGES) {
      this._recentMessages = this._recentMessages.slice(-MAX_RECENT_MESSAGES);
    }
  }

  /** Called when a tool is used during chat */
  onToolCall(): void {
    this._attributes.adjust("hunger", -TOOL_HUNGER_COST);
  }

  /** Get current eval state (for debugging/UI) */
  getState() {
    return {
      msgCount: this._msgCount,
      lastEvalAt: this._lastEvalAt,
      streak: this._streak,
      lastDirection: this._lastDirection,
      nextEvalIn: Math.max(0, EVAL_INTERVAL_MESSAGES - (this._msgCount % EVAL_INTERVAL_MESSAGES)),
    };
  }

  private _triggerEval(): void {
    if (!this._llmEval) return;

    this._lastEvalAt = Date.now();
    const prompt = EVAL_PROMPT_TEMPLATE.replace(
      "{recentMessages}",
      this._recentMessages.join("\n"),
    );

    // Async — does not block chat
    this._llmEval(prompt)
      .then((result) => {
        const intentKey = ALL_INTENTS.has(result.intent) ? result.intent as ChatIntent : "neutral";
        const base = INTENT_EFFECTS[intentKey];

        // Direction tracking
        const direction = base.mood > 0 ? "positive" : base.mood < 0 ? "negative" : null;
        if (direction && direction === this._lastDirection) {
          this._streak++;
        } else {
          this._streak = 1;
          this._lastDirection = direction;
        }

        // Apply streak multiplier
        const multiplier = streakMultiplier(this._streak);
        const finalMood = Math.round(base.mood * multiplier);
        const finalIntimacy = Math.round(base.intimacy * multiplier);

        // Clamp
        const clampedMood = Math.max(-15, Math.min(15, finalMood));
        const clampedIntimacy = Math.max(-5, Math.min(12, finalIntimacy));

        // Apply
        this._attributes.adjust("mood", clampedMood);
        if (clampedIntimacy > 0) this._growth.gain(clampedIntimacy);

        // EXP for chat eval
        this._levels.gainExp(5, "chat_eval");

        // Emit event
        this._bus.emit("chat:eval", {
          intent: intentKey,
          moodDelta: clampedMood,
          intimacyDelta: clampedIntimacy,
          streak: this._streak,
        });

        this._save();
      })
      .catch(() => {
        // LLM call failed — silent skip
      });
  }

  private _save(): void {
    this._store.save(STORE_KEY, {
      msgCount: this._msgCount,
      lastEvalAt: this._lastEvalAt,
      streak: this._streak,
      lastDirection: this._lastDirection,
      recentMessages: this._recentMessages,
    });
  }
}
