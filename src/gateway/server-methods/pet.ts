/**
 * Gateway RPC handlers for the Pet Engine.
 *
 * Methods:
 *   pet.state.get           — full state snapshot
 *   pet.interact            — process user interaction
 *   pet.growth.info         — growth stage details
 *   pet.persona.get/set     — persona management
 *   pet.config.get          — combined state + persona + settings
 *   pet.config.set          — update pet settings (fsAccess toggle, etc.)
 *   pet.skill.record        — record domain activity
 *   pet.skill.tool          — record tool use
 *   pet.skill.attributes    — get skill attribute levels
 *   pet.skill.tools         — get tool almanac data
 *   pet.skill.realized      — get realized skills
 *   pet.skill.addRealized   — add a realized skill
 *   pet.learn.courses       — list available courses
 *   pet.learn.add           — add a course
 *   pet.learn.start         — start a lesson
 *   pet.learn.abort         — abort current lesson
 *   pet.learn.active        — get active lesson
 *   pet.learn.progress      — get category progress
 *   pet.learn.history       — get completed courses
 *   pet.achievement.list    — list all achievements
 *   pet.achievement.check   — trigger achievement check
 *   pet.level.info          — get level, EXP, title
 *   pet.care.feed           — use food item to feed pet
 *   pet.care.play           — perform play action
 *   pet.care.rest           — start resting
 *   pet.care.heal           — use healing item
 *   pet.chat.canChat        — check if pet has enough hunger to chat
 *   pet.chat.eval           — get chat eval state
 *   pet.chat.onMessage      — notify chat system of user message
 *   pet.chat.onToolCall     — notify chat system of tool call
 *   pet.inventory.list      — list backpack items
 *   pet.inventory.use       — use an inventory item
 *   pet.daily.tasks         — get today's tasks
 *   pet.daily.claim         — claim completed task reward
 *   pet.daily.streak        — get login streak info
 *   pet.shop.list           — get shop items with purchase limits
 *   pet.shop.buy            — buy an item (deduct coins, check limits)
 *   pet.wallet.info         — get star-coin balance & stats
 *   pet.memory.sync         — sync MemoryGraph clusters into memory search index
 */

import {
  createPetEngine,
  type PetEngine,
  type PersistenceStore,
  inferDomainFromText,
} from "../../pet/index.js";
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

function getPetStorePath(): string {
  const base = resolveStateDir();
  const dir = path.join(base, "store", "pet");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createFileStore(): PersistenceStore {
  const dir = getPetStorePath();

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
        console.error(`[pet:store] failed to save ${key}:`, e);
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

// ─── Singleton engine instance ───

let engine: PetEngine | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let bootstrapHookRegistered = false;

function getEngine(): PetEngine {
  if (!engine) {
    const store = createFileStore();
    engine = createPetEngine({ store });

    // Tick the engine every 1 second
    tickInterval = setInterval(() => {
      engine?.tick(1000);
    }, 1000);

    // Register the agent:bootstrap hook once to inject PET_STATE.md
    if (!bootstrapHookRegistered) {
      bootstrapHookRegistered = true;
      registerInternalHook("agent:bootstrap", (event) => {
        const ctx = event.context as AgentBootstrapHookContext;
        if (!Array.isArray(ctx.bootstrapFiles)) return;

        const eng = engine;
        if (!eng) return;

        const petContent = eng.getPromptContext();
        if (!petContent.trim()) return;

        // Insert PET_STATE.md right after SOUL.md (or append at end)
        const soulIdx = ctx.bootstrapFiles.findIndex((f) => f.name === "SOUL.md");
        const insertIdx = soulIdx >= 0 ? soulIdx + 1 : ctx.bootstrapFiles.length;
        ctx.bootstrapFiles.splice(insertIdx, 0, {
          name: "PET_STATE.md" as WorkspaceBootstrapFile["name"],
          path: "PET_STATE.md",
          content: petContent,
          missing: false,
        });
      });
    }
  }
  return engine;
}


/**
 * Returns pet chat gate helpers for use by the chat.send handler.
 * Returns null if the pet engine has not been initialized.
 */
export function getPetChatGate(): {
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

export function shutdownPetEngine(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  engine = null;
}

// ─── Helper ───

function safeHandler(
  fn: (engine: PetEngine, params: Record<string, unknown>) => unknown,
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

export const petHandlers: GatewayRequestHandlers = {
  // ── State ──

  "pet.state.get": safeHandler((e) => e.getState()),

  "pet.interact": ({ params, respond }) => {
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

  "pet.growth.info": safeHandler((e) => {
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

  "pet.persona.get": safeHandler((e) => ({
    base: e.persona.base,
    resolved: e.persona.resolve(),
  })),

  "pet.persona.set": ({ params, respond }) => {
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

  "pet.config.get": safeHandler((e) => ({
    ...e.getState(),
    persona: { base: e.persona.base, resolved: e.persona.resolve() },
    settings: {
      fsAccess: getFsAccessSettings(),
    },
  })),

  "pet.config.set": async ({ params, respond }) => {
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

  "pet.skill.record": ({ params, respond }) => {
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

  "pet.skill.tool": ({ params, respond }) => {
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

  "pet.skill.attributes": safeHandler((e) => e.skills.getAttributes()),

  "pet.skill.tools": safeHandler((e) => e.skills.getToolData()),

  "pet.skill.realized": safeHandler((e) => e.skills.getRealizedSkills()),

  "pet.skill.addRealized": ({ params, respond }) => {
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

  "pet.learn.courses": safeHandler((e) => e.learning.getCourses()),

  "pet.learn.add": ({ params, respond }) => {
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

  "pet.learn.start": ({ params, respond }) => {
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

  "pet.learn.abort": safeHandler((e) => {
    e.learning.abortLesson();
    return { ok: true };
  }),

  "pet.learn.active": safeHandler((e) => e.learning.getActiveLesson()),

  "pet.learn.progress": ({ params, respond }) => {
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

  "pet.learn.history": safeHandler((e) => e.learning.getHistory()),

  // ── Achievements ──

  "pet.achievement.list": safeHandler((e) => e.achievements.getAll()),

  "pet.achievement.check": safeHandler((e) => {
    const newlyUnlocked = e.achievements.check();
    return {
      newlyUnlocked: newlyUnlocked.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
    };
  }),

  // ── Level ──

  "pet.level.info": safeHandler((e) => e.levels.getInfo()),

  // ── Care ──

  "pet.care.feed": ({ params, respond }) => {
    const itemId = (params?.itemId as string) ?? "ration_42";
    try {
      const e = getEngine();
      const result = e.care.feed(itemId);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "pet.care.play": ({ params, respond }) => {
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

  "pet.care.rest": ({ params, respond }) => {
    const typeId = (params?.typeId as string) ?? "nap";
    try {
      const e = getEngine();
      const result = e.care.rest(typeId);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "pet.care.heal": ({ params, respond }) => {
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

  "pet.chat.canChat": safeHandler((e) => e.chatEval.canChat()),

  "pet.chat.eval": safeHandler((e) => e.chatEval.getState()),

  "pet.chat.onMessage": ({ params, respond }) => {
    const text = (params?.text as string) ?? "";
    try {
      const e = getEngine();
      const result = e.chatEval.onUserMessage(text);
      (respond as Function)(result.ok, { ...result, state: e.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "pet.chat.onToolCall": safeHandler((e) => {
    e.chatEval.onToolCall();
    return { ok: true };
  }),

  // ── Inventory ──

  "pet.inventory.list": safeHandler((e) => ({
    items: e.inventory.list(),
    capacity: e.inventory.capacity,
    usedSlots: e.inventory.usedSlots,
  })),

  "pet.inventory.use": ({ params, respond }) => {
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

  "pet.daily.tasks": async ({ params: _params, respond }) => {
    try {
      const e = getEngine();
      const tasks = await e.dailyTasks.ensureTodayTasks();
      (respond as Function)(true, { tasks, counters: e.dailyTasks.getCounters() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "pet.daily.claim": ({ params, respond }) => {
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

  "pet.daily.streak": safeHandler((e) => e.login.getInfo()),

  // ── Shop & Wallet ──

  "pet.shop.list": safeHandler((e) => ({
    items: e.shop.listShop(),
    wallet: e.shop.getWallet(),
  })),

  "pet.shop.buy": ({ params, respond }) => {
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

  "pet.wallet.info": safeHandler((e) => e.shop.getWallet()),

  // ── Memory ──

  "pet.memory.sync": async ({ params, respond }) => {
    try {
      const clusters = params?.clusters as MemoryClusterInput[] | undefined;
      if (!Array.isArray(clusters) || clusters.length === 0) {
        (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing or empty 'clusters' param"));
        return;
      }

      const cfg = loadConfig();
      const agentId = resolveDefaultAgentId(cfg);
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error ?? "memory search unavailable"));
        return;
      }

      if (!manager.indexClusters) {
        (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "indexClusters not supported by current memory backend"));
        return;
      }

      manager.indexClusters(clusters);
      (respond as Function)(true, { ok: true, indexed: clusters.length });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
