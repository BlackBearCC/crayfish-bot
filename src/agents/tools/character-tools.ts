/**
 * Character Tools — Pet-specific tools for AI self-care, memory, and expression
 *
 * These tools allow the AI to:
 * 1. Take care of itself (feed/rest/play)
 * 2. Proactively remember important user information
 * 3. Express emotions through animations
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ─── Schemas ───

const CharacterSelfCareSchema = Type.Object({
  action: Type.Union([
    Type.Literal("feed"),
    Type.Literal("rest"),
    Type.Literal("play"),
  ]),
  reason: Type.String(),
});

const CharacterRememberSchema = Type.Object({
  fact: Type.String(),
  category: Type.Union([
    Type.Literal("preference"),
    Type.Literal("project"),
    Type.Literal("habit"),
    Type.Literal("relationship"),
  ]),
});

const CharacterExpressMoodSchema = Type.Object({
  emotion: Type.Union([
    Type.Literal("happy"),
    Type.Literal("sad"),
    Type.Literal("excited"),
    Type.Literal("sleepy"),
    Type.Literal("curious"),
  ]),
});

const CharacterMemoryGraphSearchSchema = Type.Object({
  query: Type.String(),
});

// ─── Rate limiting ───

const characterToolCallsPerTurn = new Map<string, number>();
const MAX_CALLS_PER_TURN = 2;

function checkRateLimit(sessionKey: string): boolean {
  const calls = characterToolCallsPerTurn.get(sessionKey) ?? 0;
  if (calls >= MAX_CALLS_PER_TURN) {
    return false;
  }
  characterToolCallsPerTurn.set(sessionKey, calls + 1);
  return true;
}

export function resetCharacterToolRateLimit(sessionKey: string): void {
  characterToolCallsPerTurn.delete(sessionKey);
}

// ─── Tools ───

export function createCharacterSelfCareTool(options?: {
  broadcast?: (channel: string, payload: unknown) => void;
  engine?: {
    care: {
      feed: (id: string) => { ok: boolean; reason?: string };
      rest: (type: string) => { ok: boolean; reason?: string };
      play: (type: string) => { ok: boolean; reason?: string };
    };
    getState: () => unknown;
    bus: { emit: (event: string, data: unknown) => void };
  };
}): AnyAgentTool {
  return {
    label: "Character Self Care",
    name: "character_self_care",
    description:
      "Use when you feel your character state is abnormal (very hungry, tired, or bored). Automatically feeds, rests, or plays to improve your state. Limited to 2 calls per turn, subject to cooldowns.",
    parameters: CharacterSelfCareSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true }) as "feed" | "rest" | "play";
      const reason = readStringParam(params, "reason", { required: true });

      const engine = options?.engine;
      if (!engine) {
        return jsonResult({ ok: false, error: "Character engine not initialized" });
      }

      try {
        let result: { ok: boolean; reason?: string };

        switch (action) {
          case "feed":
            result = engine.care.feed("42号口粮");
            break;
          case "rest":
            result = engine.care.rest("nap");
            break;
          case "play":
            result = engine.care.play("ball");
            break;
          default:
            return jsonResult({ ok: false, error: `Unknown action: ${action}` });
        }

        if (!result) {
          return jsonResult({ ok: false, error: "No result returned" });
        }

        if (result.ok) {
          options?.broadcast?.("character", {
            kind: "self-care",
            action,
            reason,
          });
        }

        return jsonResult({
          ok: result.ok,
          action,
          reason: result.ok ? `Successfully ${action}ed` : result.reason,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: message });
      }
    },
  };
}

export function createCharacterRememberTool(options?: {
  engine?: {
    memoryGraph: {
      enqueueExtraction: (userMsg: string, aiReply: string) => void;
    };
  };
}): AnyAgentTool {
  return {
    label: "Character Remember",
    name: "character_remember",
    description:
      "Proactively remember important information the user mentioned. Creates a memory cluster that can be recalled later via memory_search.",
    parameters: CharacterRememberSchema,
    execute: async (_toolCallId, params) => {
      const fact = readStringParam(params, "fact", { required: true });
      const category = readStringParam(params, "category", { required: true }) as
        | "preference"
        | "project"
        | "habit"
        | "relationship";

      const engine = options?.engine;
      if (!engine) {
        return jsonResult({ ok: false, error: "Character engine not initialized" });
      }

      try {
        engine.memoryGraph.enqueueExtraction(fact, "");

        return jsonResult({
          ok: true,
          remembered: { fact, category },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: message });
      }
    },
  };
}

export function createCharacterExpressMoodTool(options?: {
  broadcast?: (channel: string, payload: unknown) => void;
  engine?: {
    bus: { emit: (event: string, data: unknown) => void };
  };
}): AnyAgentTool {
  return {
    label: "Character Express Mood",
    name: "character_express_mood",
    description:
      "Express your current emotion through an animation. Use to show happiness, sadness, excitement, sleepiness, or curiosity. Does not change any stats.",
    parameters: CharacterExpressMoodSchema,
    execute: async (_toolCallId, params) => {
      const emotion = readStringParam(params, "emotion", { required: true }) as
        | "happy"
        | "sad"
        | "excited"
        | "sleepy"
        | "curious";

      const engine = options?.engine;
      if (!engine) {
        return jsonResult({ ok: false, error: "Character engine not initialized" });
      }

      try {
        const payload = {
          kind: "mood-expression",
          emotion,
          timestamp: Date.now(),
        };

        options?.broadcast?.("character", payload);
        engine.bus.emit("character:mood-expressed", { emotion });

        return jsonResult({
          ok: true,
          expressed: emotion,
          message: `Expressed ${emotion} emotion`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: message });
      }
    },
  };
}

export function createCharacterMemoryGraphSearchTool(options?: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): AnyAgentTool {
  return {
    label: "记忆图谱联想检索",
    name: "memory_graph_search",
    description:
      "在角色记忆图谱中进行语义联想检索。记忆图谱以簇（cluster）为节点、relatedClusters 为边，存储从对话中提炼的主题、偏好、人际关系和隐式关联。" +
      "适用场景：发现概念间的潜在联系、跨主题知识相似性联想、推断用户偏好与行为模式、溯源某个话题相关的历史记忆簇。" +
      "不适用：直接精确查找某条对话原文（用 sessions_history）；日常闲聊无需调用。",
    parameters: CharacterMemoryGraphSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      try {
        const cfg = options?.cfg ?? {};
        const agentId = options?.agentId ?? "";
        const { manager } = await getMemorySearchManager({ cfg, agentId });
        if (!manager) {
          return jsonResult({ ok: false, error: "Memory search unavailable" });
        }
        const results = await manager.search(query, {
          maxResults: 5,
          sourcesFilter: ["clusters"],
        });
        if (results.length === 0) {
          return jsonResult({ ok: true, results: [], message: "未找到相关记忆" });
        }
        return jsonResult({
          ok: true,
          results: results.map((r) => ({
            snippet: r.snippet,
            path: r.path,
            score: r.score,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: message });
      }
    },
  };
}

// ─── Horror Tool (unified) ───

const CharacterHorrorSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("start"),
    Type.Literal("abandon"),
    Type.Literal("skill_check"),
    Type.Literal("end"),
    Type.Literal("add_clue"),
    Type.Literal("add_npc"),
  ]),
  scenarioId: Type.Optional(Type.String()),
  attribute: Type.Optional(Type.Union([
    Type.Literal("logic"),
    Type.Literal("creativity"),
    Type.Literal("execution"),
    Type.Literal("empathy"),
    Type.Literal("sensitivity"),
  ])),
  dc: Type.Optional(Type.Number()),
  context: Type.Optional(Type.String()),
  won: Type.Optional(Type.Boolean()),
  narrative: Type.Optional(Type.String()),
  clue: Type.Optional(Type.String()),
  npcName: Type.Optional(Type.String()),
});

export function createCharacterHorrorTool(options?: {
  broadcast?: (channel: string, payload: unknown) => void;
  engine?: {
    horror: {
      getScenarios: () => Array<{ id: string; title: string; hook: string; difficulty: number; estimatedTurns: number; themes: string[] }>;
      startSession: (scenarioId: string) => unknown;
      getActiveSession: () => unknown;
      abandonSession: (sessionId: string) => { ok: boolean; reason?: string };
      performSkillCheck: (attribute: string, dc: number, context: string) =>
        { success: boolean; roll: number; playerLevel: number; effectiveScore: number; targetScore: number; sanityChange: number; attribute: string; dc: number } | { error: string };
      endSession: (won: boolean, narrative: string) =>
        { won: boolean; narrative: string; sanityRemaining: number; rewards: unknown } | { error: string };
      addClue: (clue: string) => void;
      addNpcEncounter: (npcName: string) => void;
      getEntryCost: () => number;
    };
    care: {
      feed: (id: string) => { ok: boolean; reason?: string };
    };
    getState: () => { hunger?: { value?: number } };
  };
}): AnyAgentTool {
  return {
    label: "怪谈副本系统",
    name: "character_horror",
    description:
      "怪谈副本系统——TRPG 式交互恐怖故事。" +
      "actions: " +
      "list(列出可玩剧本), " +
      "start(开始副本, 需 scenarioId), " +
      "abandon(放弃当前副本), " +
      "skill_check(技能判定, 需 attribute/dc/context), " +
      "end(结束副本, 需 won/narrative), " +
      "add_clue(记录线索, 需 clue), " +
      "add_npc(记录NPC, 需 npcName)。" +
      "属性: logic(逻辑), creativity(创造), execution(执行), empathy(共情), sensitivity(感知)。",
    parameters: CharacterHorrorSchema,
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const engine = options?.engine;
      if (!engine) {
        return jsonResult({ ok: false, error: "Character engine not initialized" });
      }

      switch (action) {
        // ── list ──
        case "list": {
          const scenarios = engine.horror.getScenarios();
          return jsonResult({
            ok: true,
            scenarios: scenarios.map((s) => ({
              id: s.id,
              title: s.title,
              hook: s.hook,
              difficulty: "⭐".repeat(s.difficulty),
              estimatedTurns: s.estimatedTurns,
              themes: s.themes,
            })),
          });
        }

        // ── start ──
        case "start": {
          const scenarioId = readStringParam(params, "scenarioId", { required: true });

          // Hunger gate
          const state = engine.getState();
          const hunger = (state.hunger as { value?: number })?.value ?? 999;
          const cost = engine.horror.getEntryCost();
          if (hunger < cost) {
            return jsonResult({ ok: false, error: `饥饿值不足（需要${cost}，当前${hunger}）。先吃点东西吧！` });
          }

          const result = engine.horror.startSession(scenarioId);
          if (result && typeof result === "object" && "error" in result) {
            return jsonResult({ ok: false, error: (result as { error: string }).error });
          }

          return jsonResult({
            ok: true,
            message: "怪谈副本已开始！接下来的对话将进入副本模式。",
            session: result,
          });
        }

        // ── abandon ──
        case "abandon": {
          const active = engine.horror.getActiveSession() as { id: string } | null;
          if (!active) {
            return jsonResult({ ok: false, error: "当前没有进行中的怪谈副本" });
          }
          const result = engine.horror.abandonSession(active.id);
          return jsonResult({ ok: result.ok, message: result.ok ? "副本已放弃。" : result.reason });
        }

        // ── skill_check ──
        case "skill_check": {
          if (!engine.horror.getActiveSession()) {
            return jsonResult({ ok: false, error: "No active horror session" });
          }
          const attribute = readStringParam(params, "attribute", { required: true });
          const dc = typeof p.dc === "number" ? p.dc : 5;
          const context = readStringParam(params, "context", { required: true });

          const result = engine.horror.performSkillCheck(attribute, dc, context);
          if ("error" in result) {
            return jsonResult({ ok: false, error: result.error });
          }
          return jsonResult({
            ok: true,
            ...result,
            hint: result.success
              ? "判定成功！请根据这个结果叙述正面的剧情发展。"
              : "判定失败！请叙述负面后果，理智值已扣减。",
          });
        }

        // ── end ──
        case "end": {
          if (!engine.horror.getActiveSession()) {
            return jsonResult({ ok: false, error: "No active horror session" });
          }
          const won = Boolean(p.won);
          const narrative = readStringParam(params, "narrative", { required: true });

          const result = engine.horror.endSession(won, narrative);
          if ("error" in result) {
            return jsonResult({ ok: false, error: result.error });
          }
          return jsonResult({
            ok: true,
            won: result.won,
            rewards: result.rewards,
            message: won ? "副本通关！奖励已发放。" : "副本失败，但获得了部分奖励。",
          });
        }

        // ── add_clue ──
        case "add_clue": {
          if (!engine.horror.getActiveSession()) {
            return jsonResult({ ok: false, error: "No active horror session" });
          }
          const clue = readStringParam(params, "clue", { required: true });
          engine.horror.addClue(clue);
          return jsonResult({ ok: true, clue });
        }

        // ── add_npc ──
        case "add_npc": {
          if (!engine.horror.getActiveSession()) {
            return jsonResult({ ok: false, error: "No active horror session" });
          }
          const npcName = readStringParam(params, "npcName", { required: true });
          engine.horror.addNpcEncounter(npcName);
          return jsonResult({ ok: true, npcName });
        }

        default:
          return jsonResult({ ok: false, error: `Unknown action: ${action}` });
      }
    },
  };
}

// ─── Export all tools ───

export function createCharacterTools(options?: {
  broadcast?: (channel: string, payload: unknown) => void;
  cfg?: OpenClawConfig;
  agentId?: string;
  engine?: {
    care: {
      feed: (id: string) => { ok: boolean; reason?: string };
      rest: (type: string) => { ok: boolean; reason?: string };
      play: (type: string) => { ok: boolean; reason?: string };
    };
    memoryGraph: {
      enqueueExtraction: (userMsg: string, aiReply: string) => void;
    };
    horror: {
      getScenarios: () => Array<{ id: string; title: string; hook: string; difficulty: number; estimatedTurns: number; themes: string[] }>;
      startSession: (scenarioId: string) => unknown;
      getActiveSession: () => unknown;
      abandonSession: (sessionId: string) => { ok: boolean; reason?: string };
      performSkillCheck: (attribute: string, dc: number, context: string) =>
        { success: boolean; roll: number; playerLevel: number; effectiveScore: number; targetScore: number; sanityChange: number; attribute: string; dc: number } | { error: string };
      endSession: (won: boolean, narrative: string) =>
        { won: boolean; narrative: string; sanityRemaining: number; rewards: unknown } | { error: string };
      addClue: (clue: string) => void;
      addNpcEncounter: (npcName: string) => void;
      getEntryCost: () => number;
    };
    bus: { emit: (event: string, data: unknown) => void };
    getState: () => unknown;
  };
}): AnyAgentTool[] {
  return [
    createCharacterSelfCareTool(options),
    createCharacterRememberTool(options),
    createCharacterExpressMoodTool(options),
    createCharacterMemoryGraphSearchTool({ cfg: options?.cfg, agentId: options?.agentId }),
    createCharacterHorrorTool({ broadcast: options?.broadcast, engine: options?.engine as Parameters<typeof createCharacterHorrorTool>[0] extends { engine?: infer E } ? E : never }),
  ];
}
