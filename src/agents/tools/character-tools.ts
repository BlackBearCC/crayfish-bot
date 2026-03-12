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
    name: "self_care",
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
    name: "remember",
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
    name: "express_mood",
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
    bus: { emit: (event: string, data: unknown) => void };
    getState: () => unknown;
  };
}): AnyAgentTool[] {
  return [
    createCharacterSelfCareTool(options),
    createCharacterRememberTool(options),
    createCharacterExpressMoodTool(options),
    createCharacterMemoryGraphSearchTool({ cfg: options?.cfg, agentId: options?.agentId }),
  ];
}
