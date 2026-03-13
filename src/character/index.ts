/**
 * Character Engine — Public API
 *
 * All exports for consumers of the character engine.
 */

// Core
export { EventBus, type CharacterEventMap } from "./event-bus.js";
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

// Subsystems
export { SkillSystem, type RealizedSkill, type EpiphanyEvent, type AttrLevelInfo } from "./skill-system.js";
export { LearningSystem, type Course, type ActiveLesson, type LessonResult, LEVEL_THRESHOLDS } from "./learning-system.js";
export { AchievementSystem } from "./achievement-system.js";

// Nurturing subsystems
export { LevelSystem, LEVEL_EXP, MAX_LEVEL, LEVEL_TIERS, type LevelTier } from "./level-system.js";
export { InventorySystem, ITEM_DEFS, type ItemDef, type InventorySlot } from "./inventory-system.js";
export { CareSystem, PLAY_ACTIONS, REST_TYPES, type PlayAction, type RestType } from "./care-system.js";
export {
  ChatEvalSystem,
  INTENT_EFFECTS,
  CHAT_HUNGER_COST,
  TOOL_HUNGER_COST,
  MIN_HUNGER_TO_CHAT,
  streakMultiplier,
  type ChatIntent,
  type LLMEvalCallback,
} from "./chat-eval-system.js";
export { LoginTracker } from "./login-tracker.js";
export {
  ShopSystem,
  SHOP_CATALOG,
  type ShopItemDef,
  type WalletInfo,
  type ShopListItem,
  type BuyResult,
} from "./shop-system.js";
export {
  DailyTaskSystem,
  type DailyTask,
  type TaskCondition,
  type TaskReward,
  type DailyCounters,
  type TaskLLMCallback,
} from "./daily-task-system.js";

// Memory graph
export {
  MemoryGraphSystem,
  type LLMCompleteCallback,
  type MemoryCluster,
  type MemoryFragment,
} from "./memory-graph.js";

// World events
export {
  WorldEventSystem,
  type WorldEvent,
} from "./world-event-system.js";

// Horror system
export {
  HorrorSystem,
  type HorrorSession,
  type HorrorSessionStatus,
  type HorrorOutcome,
  type HorrorRewards,
  type SkillCheckResult,
  type HorrorLLMCallback,
} from "./horror-system.js";
export {
  BUILTIN_SCENARIOS,
  type HorrorScenario,
  type HorrorNPC,
  type SkillCheckHint,
} from "./horror-scenarios.js";

// Domain definitions
export {
  DOMAINS,
  SKILL_ATTRIBUTES,
  DOMAIN_ATTR_WEIGHTS,
  inferDomainFromText,
  isValidDomain,
  type DomainDef,
  type SkillAttributeDef,
} from "./domain-system.js";

// Presets
export {
  DEFAULT_ATTRIBUTES,
  ATTR_MOOD,
  ATTR_HUNGER,
  ATTR_HEALTH,
  GROWTH_INTIMACY,
} from "./presets.js";

// Main entry
export {
  CharacterEngine,
  createCharacterEngine,
  type CharacterEngineOptions,
  type CharacterState,
} from "./character-engine.js";
