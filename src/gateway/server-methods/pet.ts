/**
 * Gateway RPC handlers for the Pet Engine.
 *
 * Methods:
 *   pet.state.get     — get full pet state snapshot
 *   pet.interact      — process a user interaction (click/feed/drag/etc.)
 *   pet.growth.info   — get growth stage details
 *   pet.persona.get   — get current resolved persona
 *   pet.persona.set   — update base persona
 *   pet.config.get    — get pet engine configuration
 */

import {
  createPetEngine,
  type PetEngine,
  type PersistenceStore,
  type AttributeState,
} from "../../pet/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// ─── File-based persistence store ───

import fs from "node:fs";
import path from "node:path";
import { resolveStorePath } from "../../config/sessions/paths.js";

function getPetStorePath(): string {
  const base = resolveStorePath();
  const dir = path.join(base, "pet");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createFileStore(): PersistenceStore {
  const dir = getPetStorePath();

  return {
    load(key: string): AttributeState | null {
      const file = path.join(dir, `${key}.json`);
      try {
        const raw = fs.readFileSync(file, "utf-8");
        return JSON.parse(raw) as AttributeState;
      } catch {
        return null;
      }
    },
    save(key: string, state: AttributeState): void {
      const file = path.join(dir, `${key}.json`);
      try {
        fs.writeFileSync(file, JSON.stringify(state), "utf-8");
      } catch (e) {
        console.error(`[pet:store] failed to save ${key}:`, e);
      }
    },
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

// ─── RPC Handlers ───

export const petHandlers: GatewayRequestHandlers = {
  "pet.state.get": ({ respond }) => {
    try {
      const state = getEngine().getState();
      respond(true, state);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "pet.interact": ({ params, respond }) => {
    const action = params?.action as string | undefined;
    if (!action) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'action' param"));
      return;
    }

    const customRewards = params?.rewards as Record<string, number> | undefined;
    try {
      getEngine().interact(action, customRewards);
      const state = getEngine().getState();
      respond(true, state);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "pet.growth.info": ({ respond }) => {
    try {
      const g = getEngine().growth;
      respond(true, {
        points: g.points,
        stage: g.stage,
        stageName: g.stageDef.name,
        pointsToNext: g.pointsToNext,
        stages: g.stages,
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "pet.persona.get": ({ respond }) => {
    try {
      respond(true, {
        base: getEngine().persona.base,
        resolved: getEngine().persona.resolve(),
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "pet.persona.set": ({ params, respond }) => {
    const persona = params?.persona as string | undefined;
    if (!persona) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'persona' param"));
      return;
    }
    try {
      getEngine().persona.setBase(persona);
      respond(true, { base: persona, resolved: getEngine().persona.resolve() });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },

  "pet.config.get": ({ respond }) => {
    try {
      const state = getEngine().getState();
      respond(true, {
        ...state,
        persona: {
          base: getEngine().persona.base,
          resolved: getEngine().persona.resolve(),
        },
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(e)));
    }
  },
};
