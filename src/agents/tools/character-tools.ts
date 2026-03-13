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

// ─── Horror Tools ───

const HorrorSkillCheckSchema = Type.Object({
  attribute: Type.Union([
    Type.Literal("logic"),
    Type.Literal("creativity"),
    Type.Literal("execution"),
    Type.Literal("empathy"),
    Type.Literal("sensitivity"),
  ]),
  dc: Type.Number(),
  context: Type.String(),
});

const HorrorEndSessionSchema = Type.Object({
  won: Type.Boolean(),
  narrative: Type.String(),
});

const HorrorAddClueSchema = Type.Object({
  clue: Type.String(),
});

const HorrorAddNpcSchema = Type.Object({
  npcName: Type.String(),
});

export function createHorrorSkillCheckTool(options?: {
  engine?: {
    horror: {
      performSkillCheck: (attribute: string, dc: number, context: string) =>
        { success: boolean; roll: number; playerLevel: number; effectiveScore: number; targetScore: number; sanityChange: number; attribute: string; dc: number } | { error: string };
      getActiveSession: () => unknown;
    };
  };
}): AnyAgentTool {
  return {
    label: "怪谈技能判定",
    name: "horror_skill_check",
    description:
      "在怪谈副本中进行技能判定。当叙事中宠物角色的行动需要能力检测时调用此工具。" +
      "属性: logic(逻辑/解谜), creativity(创造/即兴), execution(执行/体能), empathy(共情/交涉), sensitivity(感知/直觉)。" +
      "dc: 难度等级1-10。context: 简要描述判定场景。",
    parameters: HorrorSkillCheckSchema,
    execute: async (_toolCallId, params) => {
      const attribute = readStringParam(params, "attribute", { required: true });
      const dc = typeof params === "object" && params !== null && "dc" in params ? Number((params as Record<string, unknown>).dc) : 5;
      const context = readStringParam(params, "context", { required: true });

      const engine = options?.engine;
      if (!engine) {
        return jsonResult({ ok: false, error: "Character engine not initialized" });
      }

      if (!engine.horror.getActiveSession()) {
        return jsonResult({ ok: false, error: "No active horror session" });
      }

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
    },
  };
}

export function createHorrorEndSessionTool(options?: {
  engine?: {
    horror: {
      endSession: (won: boolean, narrative: string) =>
        { won: boolean; narrative: string; sanityRemaining: number; rewards: unknown } | { error: string };
      getActiveSession: () => unknown;
    };
  };
}): AnyAgentTool {
  return {
    label: "怪谈结束副本",
    name: "horror_end_session",
    description:
      "当怪谈副本达成胜利或失败条件时调用此工具结束副本。" +
      "won: 是否胜利。narrative: 结局叙事文本。",
    parameters: HorrorEndSessionSchema,
    execute: async (_toolCallId, params) => {
      const won = typeof params === "object" && params !== null && "won" in params ? Boolean((params as Record<string, unknown>).won) : false;
      const narrative = readStringParam(params, "narrative", { required: true });

      const engine = options?.engine;
      if (!engine) {
        return jsonResult({ ok: false, error: "Character engine not initialized" });
      }

      if (!engine.horror.getActiveSession()) {
        return jsonResult({ ok: false, error: "No active horror session" });
      }

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
    },
  };
}

export function createHorrorAddClueTool(options?: {
  engine?: {
    horror: {
      addClue: (clue: string) => void;
      getActiveSession: () => unknown;
    };
  };
}): AnyAgentTool {
  return {
    label: "怪谈记录线索",
    name: "horror_add_clue",
    description: "在怪谈副本中发现新线索时调用此工具记录。clue: 线索的简短描述。",
    parameters: HorrorAddClueSchema,
    execute: async (_toolCallId, params) => {
      const clue = readStringParam(params, "clue", { required: true });
      const engine = options?.engine;
      if (!engine || !engine.horror.getActiveSession()) {
        return jsonResult({ ok: false, error: "No active horror session" });
      }
      engine.horror.addClue(clue);
      return jsonResult({ ok: true, clue });
    },
  };
}

export function createHorrorAddNpcTool(options?: {
  engine?: {
    horror: {
      addNpcEncounter: (npcName: string) => void;
      getActiveSession: () => unknown;
    };
  };
}): AnyAgentTool {
  return {
    label: "怪谈记录NPC",
    name: "horror_add_npc",
    description: "在怪谈副本中首次遇到NPC时调用此工具记录。npcName: NPC的名字。",
    parameters: HorrorAddNpcSchema,
    execute: async (_toolCallId, params) => {
      const npcName = readStringParam(params, "npcName", { required: true });
      const engine = options?.engine;
      if (!engine || !engine.horror.getActiveSession()) {
        return jsonResult({ ok: false, error: "No active horror session" });
      }
      engine.horror.addNpcEncounter(npcName);
      return jsonResult({ ok: true, npcName });
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
      performSkillCheck: (attribute: string, dc: number, context: string) =>
        { success: boolean; roll: number; playerLevel: number; effectiveScore: number; targetScore: number; sanityChange: number; attribute: string; dc: number } | { error: string };
      endSession: (won: boolean, narrative: string) =>
        { won: boolean; narrative: string; sanityRemaining: number; rewards: unknown } | { error: string };
      addClue: (clue: string) => void;
      addNpcEncounter: (npcName: string) => void;
      getActiveSession: () => unknown;
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
    createHorrorSkillCheckTool(options),
    createHorrorEndSessionTool(options),
    createHorrorAddClueTool(options),
    createHorrorAddNpcTool(options),
  ];
}
