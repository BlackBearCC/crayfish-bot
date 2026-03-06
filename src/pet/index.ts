/**
 * Pet Engine — Public API
 *
 * All exports for consumers of the pet engine.
 */

export { EventBus, type PetEventMap } from "./event-bus.js";
export {
  AttributeEngine,
  type AttributeDef,
  type AttributeLevel,
  type AttributeDependency,
  type AttributeState,
  type PersistenceStore,
} from "./attribute-engine.js";
export { GrowthSystem, type GrowthConfig, type GrowthStageDef } from "./growth-system.js";
export { PersonaEngine, type PersonaModifier } from "./persona-engine.js";
export {
  PetEngine,
  createPetEngine,
  type PetEngineOptions,
  type PetState,
} from "./pet-engine.js";
export {
  DEFAULT_ATTRIBUTES,
  ATTR_MOOD,
  ATTR_HUNGER,
  ATTR_HEALTH,
  GROWTH_INTIMACY,
} from "./presets.js";
