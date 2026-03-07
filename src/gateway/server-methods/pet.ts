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
 */

import {
  createPetEngine,
  type PetEngine,
  type PersistenceStore,
  inferDomainFromText,
} from "../../pet/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// ─── File-based persistence store ───

import fs from "node:fs";
import path from "node:path";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadConfig, readConfigFileSnapshotForWrite, writeConfigFile } from "../../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";

function getPetStorePath(): string {
  const base = resolveStorePath();
  const dir = path.join(base, "pet");
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

function getEngine(): PetEngine {
  if (!engine) {
    const store = createFileStore();
    engine = createPetEngine({ store });

    // Tick the engine every 1 second
    tickInterval = setInterval(() => {
      engine?.tick(1000);
    }, 1000);
  }
  return engine;
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
};
