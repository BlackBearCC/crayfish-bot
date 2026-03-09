/**
 * Gateway RPC handlers for the Character Engine.
 *
 * Methods:
 *   character.state.get           — full state snapshot
 *   character.interact            — process user interaction
 *   character.growth.info         — growth stage details
 *   character.persona.get/set     — persona management
 *   character.config.get          — combined state + persona + settings
 *   character.config.set          — update character settings (fsAccess toggle, etc.)
 *   character.skill.record        — record domain activity
 *   character.skill.tool          — record tool use
 *   character.skill.attributes    — get skill attribute levels
 *   character.skill.tools         — get tool almanac data
 *   character.skill.realized      — get realized skills
 *   character.skill.addRealized   — add a realized skill
 *   character.learn.courses       — list available courses
 *   character.learn.add           — add a course
 *   character.learn.start         — start a lesson
 *   character.learn.abort         — abort current lesson
 *   character.learn.active        — get active lesson
 *   character.learn.progress      — get category progress
 *   character.learn.history       — get completed courses
 *   character.achievement.list    — list all achievements
 *   character.achievement.check   — trigger achievement check
 *   character.level.info          — get level, EXP, title
 *   character.care.feed           — use food item to feed character
 *   character.care.play           — perform play action
 *   character.care.rest           — start resting
 *   character.care.heal           — use healing item
 *   character.chat.canChat        — check if character has enough hunger to chat
 *   character.chat.eval           — get chat eval state
 *   character.chat.onMessage      — notify chat system of user message
 *   character.chat.onToolCall     — notify chat system of tool call
 *   character.inventory.list      — list backpack items
 *   character.inventory.use       — use an inventory item
 *   character.daily.tasks         — get today's tasks
 *   character.daily.claim         — claim completed task reward
 *   character.daily.streak        — get login streak info
 *   character.shop.list           — get shop items with purchase limits
 *   character.shop.buy            — buy an item (deduct coins, check limits)
 *   character.wallet.info         — get star-coin balance & stats
 *   character.memory.extract      — enqueue memory extraction from chat (userMsg + aiReply)
 *   character.memory.clusters     — get memory cluster data (for UI panel)
 */

import {
  createCharacterEngine,
  type CharacterEngine,
  type PersistenceStore,
  inferDomainFromText,
} from "../../character/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../../hooks/internal-hooks.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import type { GatewayRequestHandlers } from "./types.js";

// ─── File-based persistence store ───

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadConfig, readConfigFileSnapshotForWrite, writeConfigFile } from "../../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemoryClusterInput } from "../../memory/types.js";
import { getGlobalPluginRegistry } from "../../plugins/hook-runner-global.js";
import type { PluginHookRegistration } from "../../plugins/types.js";

function getCharacterStorePath(): string {
  const base = resolveStateDir();
  const newDir = path.join(base, "store", "character");
  // Migrate legacy store/pet/ → store/character/
  if (!fs.existsSync(newDir)) {
    const legacyDir = path.join(base, "store", "pet");
    if (fs.existsSync(legacyDir)) {
      fs.renameSync(legacyDir, newDir);
    } else {
      fs.mkdirSync(newDir, { recursive: true });
    }
  }
  return newDir;
}

function createFileStore(): PersistenceStore {
  const dir = getCharacterStorePath();

  return {
    load(key: string): Record<string, unknown> | null {
      const file = path.join(dir, `${key}.json`);
      try {
        const raw = fs.readFileSync(file, "utf-8");
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    save(key: string, data: Record<string, unknown>): void {
      const file = path.join(dir, `${key}.json`);
      try {
        fs.writeFileSync(file, JSON.stringify(data), "utf-8");
      } catch (e) {
        console.error(`[character:store] failed to save ${key}:`, e);
      }
    },
  };
}

// ─── Settings helpers ───

function getFsAccessSettings() {
  const cfg = loadConfig();
  const workspaceOnly = cfg.tools?.fs?.workspaceOnly === true;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const workDir = resolveAgentWorkspaceDir(cfg, defaultAgentId);
  return {
    fullAccess: !workspaceOnly,
    workDir,
  };
}

// ─── LLM completion for character subsystems (memory extraction, chat eval) ───

function resolveCharacterLLMConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const cfg = loadConfig();
  const primaryModel = (cfg as Record<string, unknown> as { agents?: { defaults?: { model?: { primary?: string } } } }).agents?.defaults?.model?.primary;
  const providers = cfg.models?.providers;
  if (!primaryModel || !providers) return null;

  const slashIdx = primaryModel.indexOf("/");
  if (slashIdx <= 0) return null;

  const providerKey = primaryModel.substring(0, slashIdx);
  const modelName = primaryModel.substring(slashIdx + 1);
  const provider = providers[providerKey];
  if (!provider?.baseUrl || !provider?.apiKey) return null;

  return {
    baseUrl: provider.baseUrl,
    apiKey: String(provider.apiKey),
    model: modelName,
  };
}

async function characterLLMComplete(prompt: string): Promise<string | null> {
  const llmCfg = resolveCharacterLLMConfig();
  if (!llmCfg) return null;
  try {
    const res = await fetch(`${llmCfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmCfg.apiKey}`,
      },
      body: JSON.stringify({
        model: llmCfg.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
        temperature: 0.85,
        stream: false,
        enable_thinking: false,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

// ─── Tool → Domain mapping (for automatic skill tracking) ───

const TOOL_DOMAIN_MAP: Record<string, string> = {
  web_search: "研究",
  search: "研究",
  memory_search: "研究",
  code_execute: "技术",
  code_interpreter: "技术",
  read: "技术",
  edit: "技术",
  write: "技术",
  bash: "技术",
  image_gen: "创意",
  openai_image_gen: "创意",
  send: "沟通",
  push: "沟通",
};

// ─── Singleton engine instance ───

let engine: CharacterEngine | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let hooksRegistered = false;

/**
 * Per-session cache of the last user message, used to pair with
 * the subsequent message:sent hook for memory extraction.
 * Entries are timestamped and evicted after 5 minutes to prevent leaks
 * when a message:received is never followed by message:sent.
 */
const lastUserMessageBySession = new Map<string, { text: string; ts: number }>();
const USER_MSG_TTL_MS = 5 * 60_000;

function setLastUserMessage(sessionKey: string, text: string): void {
  lastUserMessageBySession.set(sessionKey, { text, ts: Date.now() });
  // Evict stale entries when map grows beyond reasonable size
  if (lastUserMessageBySession.size > 200) {
    const now = Date.now();
    for (const [k, v] of lastUserMessageBySession) {
      if (now - v.ts > USER_MSG_TTL_MS) lastUserMessageBySession.delete(k);
    }
  }
}

function consumeLastUserMessage(sessionKey: string): string {
  const entry = lastUserMessageBySession.get(sessionKey);
  lastUserMessageBySession.delete(sessionKey);
  if (!entry || Date.now() - entry.ts > USER_MSG_TTL_MS) return "";
  return entry.text;
}

/**
 * Register OpenClaw hooks for character engine integration.
 * - agent:bootstrap — inject CHARACTER_STATE.md into agent context
 * - after_tool_call — auto-record tool usage for skill tracking (all channels)
 */
function registerCharacterHooks(eng: CharacterEngine): void {
  // ── agent:bootstrap — inject state context after SOUL.md ──
  registerInternalHook("agent:bootstrap", (event) => {
    const ctx = event.context as AgentBootstrapHookContext;
    if (!Array.isArray(ctx.bootstrapFiles) || !engine) return;

    const content = engine.getPromptContext();
    if (!content.trim()) return;

    const soulIdx = ctx.bootstrapFiles.findIndex((f) => f.name === "SOUL.md");
    const insertIdx = soulIdx >= 0 ? soulIdx + 1 : ctx.bootstrapFiles.length;
    ctx.bootstrapFiles.splice(insertIdx, 0, {
      name: "CHARACTER_STATE.md" as WorkspaceBootstrapFile["name"],
      path: "CHARACTER_STATE.md",
      content,
      missing: false,
    });
  });

  // ── message:received — cache user message for memory extraction pairing ──
  registerInternalHook("message:received", (event) => {
    const ctx = event.context as { content?: string };
    if (ctx.content && event.sessionKey) {
      setLastUserMessage(event.sessionKey, ctx.content);
    }
  });

  // ── message:sent — auto-trigger memory extraction across all channels ──
  registerInternalHook("message:sent", (event) => {
    const ctx = event.context as { content?: string; success?: boolean };
    if (!ctx.success || !ctx.content || !engine) return;

    const userMsg = consumeLastUserMessage(event.sessionKey);
    if (userMsg || ctx.content) {
      engine.memoryGraph.enqueueExtraction(userMsg, ctx.content);
    }
  });

  // ── after_tool_call — auto-record tool usage across all channels ──
  const registry = getGlobalPluginRegistry();
  if (registry) {
    registry.typedHooks.push({
      pluginId: "character-engine",
      hookName: "after_tool_call",
      handler: (event) => {
        const toolName = event.toolName;
        if (!toolName || !engine) return;

        // Record tool → skill almanac + achievements + daily task counter
        engine.recordToolUse(toolName);

        // Map tool → domain for attribute XP
        const domain = TOOL_DOMAIN_MAP[toolName];
        if (domain) {
          engine.recordDomainActivity(domain, toolName, 1.0);
        }
      },
      source: "character-engine",
    } as PluginHookRegistration<"after_tool_call">);
  }
}

function getEngine(): CharacterEngine {
  if (!engine) {
    const store = createFileStore();
    engine = createCharacterEngine({ store });

    // Tick the engine every 1 second
    tickInterval = setInterval(() => {
      engine?.tick(1000);
    }, 1000);

    // Wire up memory graph callbacks
    engine.memoryGraph.setLLMComplete(characterLLMComplete);
    engine.memoryGraph.setIndexCallback((clusters) => {
      const cfg = loadConfig();
      const agentId = resolveDefaultAgentId(cfg);
      getMemorySearchManager({ cfg, agentId })
        .then(({ manager }) => {
          if (manager?.indexClusters) {
            const payload: MemoryClusterInput[] = clusters.map((c) => ({
              id: c.id,
              theme: c.theme,
              keywords: c.keywords,
              implicitKeywords: c.implicitKeywords,
              summary: c.summary,
              fragments: c.fragments.map((f) => ({ text: f.text })),
              weight: c.weight,
              updatedAt: c.updatedAt,
            }));
            manager.indexClusters(payload);
          }
        })
        .catch(() => { /* best-effort indexing */ });
    });

    // Wire up chat eval LLM callback
    engine.chatEval.setLLMEval(async (prompt) => {
      const raw = await characterLLMComplete(prompt);
      if (!raw) return { intent: "neutral" };
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return { intent: "neutral" };
        const parsed = JSON.parse(match[0]) as { intent?: string };
        return { intent: parsed.intent ?? "neutral" };
      } catch {
        return { intent: "neutral" };
      }
    });

    // Register hooks once
    if (!hooksRegistered) {
      hooksRegistered = true;
      registerCharacterHooks(engine);
    }
  }
  return engine;
}


/**
 * Returns character chat gate helpers for use by the chat.send handler.
 * Returns null if the character engine has not been initialized.
 */
export function getCharacterChatGate(): {
  canChat: () => { ok: boolean; hunger: number; minRequired: number };
  onMessage: (text: string) => void;
} | null {
  if (!engine) return null;
  const eng = engine;
  return {
    canChat: () => eng.chatEval.canChat(),
    onMessage: (text: string) => { eng.chatEval.onUserMessage(text); },
  };
}

export function shutdownCharacterEngine(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  engine = null;
}

// ─── Helper ───

function safeHandler(
  fn: (engine: CharacterEngine, params: Record<string, unknown>) => unknown,
): (opts: { params: Record<string, unknown>; respond: Function }) => void {
  return ({ params, respond }) => {
    try {
      const result = fn(getEngine(), params);
      (respond as Function)(true, result);
    } catch (e) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  };
}

// ─── RPC Handlers ───

export const characterHandlers: GatewayRequestHandlers = {
  // ── State ──

  "character.state.get": safeHandler((e) => e.getState()),

  "character.interact": ({ params, respond }) => {
    const action = params?.action as string | undefined;
    if (!action) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'action' param"));
      return;
    }
    try {
      const e = getEngine();
      e.interact(action, params?.rewards as Record<string, number> | undefined);
      respond(true, e.getState());
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "character.growth.info": safeHandler((e) => {
    const g = e.growth;
    return {
      points: g.points,
      stage: g.stage,
      stageName: g.stageDef.name,
      pointsToNext: g.pointsToNext,
      stages: g.stages,
    };
  }),

  // ── Persona ──

  "character.persona.get": safeHandler((e) => ({
    base: e.persona.base,
    resolved: e.persona.resolve(),
  })),

  "character.persona.set": ({ params, respond }) => {
    const persona = params?.persona as string | undefined;
    if (!persona) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'persona' param"));
      return;
    }
    try {
      const e = getEngine();
      e.persona.setBase(persona);
      respond(true, { base: persona, resolved: e.persona.resolve() });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  // ── Config ──

  "character.config.get": safeHandler((e) => ({
    ...e.getState(),
    persona: { base: e.persona.base, resolved: e.persona.resolve() },
    settings: {
      fsAccess: getFsAccessSettings(),
    },
  })),

  "character.config.set": async ({ params, respond }) => {
    try {
      const settings = params?.settings as Record<string, unknown> | undefined;
      if (!settings) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'settings' param"));
        return;
      }

      const fsAccess = settings.fsAccess as Record<string, unknown> | undefined;
      if (fsAccess && typeof fsAccess.fullAccess === "boolean") {
        const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
        const cfg = { ...snapshot.config };
        cfg.tools = { ...cfg.tools, fs: { ...cfg.tools?.fs, workspaceOnly: !fsAccess.fullAccess } };
        await writeConfigFile(cfg, writeOptions);
      }

      const e = getEngine();
      respond(true, {
        ok: true,
        settings: {
          fsAccess: getFsAccessSettings(),
        },
        state: e.getState(),
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  // ── Skills ──

  "character.skill.record": ({ params, respond }) => {
    const domain = (params?.domain as string) || (params?.text ? inferDomainFromText(params.text as string) : null);
    if (!domain) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'domain' or 'text' param"));
      return;
    }
    try {
      const e = getEngine();
      e.recordDomainActivity(domain, params?.context as string, params?.weight as number);
      respond(true, { domain, attributes: e.skills.getAttributes() });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "character.skill.tool": ({ params, respond }) => {
    const toolName = params?.toolName as string;
    if (!toolName) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'toolName' param"));
      return;
    }
    try {
      getEngine().recordToolUse(toolName);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "character.skill.attributes": safeHandler((e) => e.skills.getAttributes()),

  "character.skill.tools": safeHandler((e) => e.skills.getToolData()),

  "character.skill.realized": safeHandler((e) => e.skills.getRealizedSkills()),

  "character.skill.addRealized": ({ params, respond }) => {
    try {
      const e = getEngine();
      e.skills.addRealized({
        skillName: params?.skillName as string ?? "",
        skillTitle: params?.skillTitle as string ?? "",
        skillDesc: params?.skillDesc as string ?? "",
        skillContent: params?.skillContent as string ?? "",
        domainName: params?.domainName as string ?? "",
        createdAt: Date.now(),
      });
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  // ── Learning ──

  "character.learn.courses": safeHandler((e) => e.learning.getCourses()),

  "character.learn.add": ({ params, respond }) => {
    try {
      const e = getEngine();
      const course = e.learning.addCourse({
        title: params?.title as string ?? "",
        categoryName: params?.categoryName as string ?? "",
        complexity: (params?.complexity as number) ?? 3,
      });
      respond(true, course);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "character.learn.start": ({ params, respond }) => {
    const courseId = params?.courseId as string;
    if (!courseId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'courseId' param"));
      return;
    }
    try {
      const result = getEngine().learning.startLesson(courseId);
      respond(result.ok, result);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "character.learn.abort": safeHandler((e) => {
    e.learning.abortLesson();
    return { ok: true };
  }),

  "character.learn.active": safeHandler((e) => e.learning.getActiveLesson()),

  "character.learn.progress": ({ params, respond }) => {
    const categoryName = params?.categoryName as string;
    if (!categoryName) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'categoryName' param"));
      return;
    }
    try {
      respond(true, getEngine().learning.getProgress(categoryName));
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "character.learn.history": safeHandler((e) => e.learning.getHistory()),

  // ── Achievements ──

  "character.achievement.list": safeHandler((e) => e.achievements.getAll()),

  "character.achievement.check": safeHandler((e) => {
    const newlyUnlocked = e.achievements.check();
    return {
      newlyUnlocked: newlyUnlocked.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
    };
  }),

  // ── Level ──

  "character.level.info": safeHandler((e) => e.levels.getInfo()),

  // ── Care ──

  "character.care.feed": ({ params, respond }) => {
    const itemId = (params?.itemId as string) ?? "ration_42";
    try {
      const e = getEngine();
      const result = e.care.feed(itemId);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.care.play": ({ params, respond }) => {
    const actionId = params?.actionId as string;
    if (!actionId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'actionId' param"));
      return;
    }
    try {
      const e = getEngine();
      const result = e.care.play(actionId);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.care.rest": ({ params, respond }) => {
    const typeId = (params?.typeId as string) ?? "nap";
    try {
      const e = getEngine();
      const result = e.care.rest(typeId);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.care.heal": ({ params, respond }) => {
    const itemId = params?.itemId as string;
    if (!itemId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'itemId' param"));
      return;
    }
    try {
      const e = getEngine();
      const result = e.care.heal(itemId);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  // ── Chat ──

  "character.chat.canChat": safeHandler((e) => e.chatEval.canChat()),

  "character.chat.eval": safeHandler((e) => e.chatEval.getState()),

  "character.chat.onMessage": ({ params, respond }) => {
    const text = (params?.text as string) ?? "";
    try {
      const e = getEngine();
      const result = e.chatEval.onUserMessage(text);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.chat.onToolCall": safeHandler((e) => {
    e.chatEval.onToolCall();
    return { ok: true };
  }),

  // ── Inventory ──

  "character.inventory.list": safeHandler((e) => ({
    items: e.inventory.list(),
    capacity: e.inventory.capacity,
    usedSlots: e.inventory.usedSlots,
  })),

  "character.inventory.use": ({ params, respond }) => {
    const itemId = params?.itemId as string;
    if (!itemId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'itemId' param"));
      return;
    }
    try {
      const e = getEngine();
      const result = e.inventory.useItem(itemId);
      if (!result) {
        (respond as Function)(false, { reason: "cannot_use" });
        return;
      }
      (respond as Function)(true, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  // ── Daily Tasks ──

  "character.daily.tasks": async ({ params: _params, respond }) => {
    try {
      const e = getEngine();
      const tasks = await e.dailyTasks.ensureTodayTasks();
      (respond as Function)(true, { tasks, counters: e.dailyTasks.getCounters() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.daily.claim": ({ params, respond }) => {
    const taskId = params?.taskId as string;
    if (!taskId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'taskId' param"));
      return;
    }
    try {
      const e = getEngine();
      const result = e.dailyTasks.claimTask(taskId);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.daily.streak": safeHandler((e) => e.login.getInfo()),

  // ── Shop & Wallet ──

  "character.shop.list": safeHandler((e) => ({
    items: e.shop.listShop(),
    wallet: e.shop.getWallet(),
  })),

  "character.shop.buy": ({ params, respond }) => {
    const itemId = params?.itemId as string;
    if (!itemId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'itemId' param"));
      return;
    }
    try {
      const e = getEngine();
      const qty = (params?.qty as number) ?? 1;
      const result = e.shop.buy(itemId, qty);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.wallet.info": safeHandler((e) => e.shop.getWallet()),

  // ── Memory ──

  "character.memory.extract": ({ params, respond }) => {
    try {
      const userMsg = (params?.userMsg as string) ?? "";
      const aiReply = (params?.aiReply as string) ?? "";
      if (!userMsg && !aiReply) {
        (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'userMsg' or 'aiReply' param"));
        return;
      }
      const e = getEngine();
      e.memoryGraph.enqueueExtraction(userMsg, aiReply);
      (respond as Function)(true, { ok: true, queued: true });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.memory.clusters": safeHandler((e) => ({
    clusters: e.memoryGraph.getClusters(),
    ...e.memoryGraph.getStatus(),
  })),
};
