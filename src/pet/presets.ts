/**
 * Pet Engine — Default Presets
 *
 * Standard attribute and growth definitions that replicate
 * the original desktop pet's MoodSystem, HungerSystem, HealthSystem,
 * and IntimacySystem behavior.
 *
 * Clients can use these defaults or define their own.
 */

import type { AttributeDef } from "./attribute-engine.js";
import type { GrowthConfig } from "./growth-system.js";

export const ATTR_MOOD: AttributeDef = {
  key: "mood",
  name: "心情",
  initial: 80,
  min: 15,
  max: 100,
  decayPerMinute: 0.4,
  maxOfflineHours: 4,
  offlineFloor: 20,
  levels: [
    { name: "sad", threshold: 0 },
    { name: "normal", threshold: 30 },
    { name: "happy", threshold: 52 },
    { name: "joyful", threshold: 78 },
  ],
};

export const ATTR_HUNGER: AttributeDef = {
  key: "hunger",
  name: "饱腹",
  initial: 210,
  min: 0,
  max: 300,
  decayPerMinute: 0.3,
  maxOfflineHours: 4,
  offlineFloor: 60,
  levels: [
    { name: "starving", threshold: 0 },
    { name: "hungry", threshold: 30 },
    { name: "normal", threshold: 105 },
    { name: "full", threshold: 225 },
  ],
};

export const ATTR_HEALTH: AttributeDef = {
  key: "health",
  name: "健康",
  initial: 100,
  min: 0,
  max: 100,
  decayPerMinute: 0, // driven by dependencies, not time
  maxOfflineHours: 4,
  offlineFloor: 20,
  levels: [
    { name: "sick", threshold: 0 },
    { name: "subhealthy", threshold: 35 },
    { name: "healthy", threshold: 70 },
  ],
  dependencies: [
    {
      sourceKey: "hunger",
      effect: (level) => {
        if (level === "starving") return -2;
        if (level === "hungry") return -0.8;
        if (level === "full") return 0.15;
        return 0;
      },
    },
    {
      sourceKey: "mood",
      effect: (level) => {
        if (level === "sad") return -0.8;
        if (level === "joyful") return 0.15;
        return 0;
      },
    },
  ],
};

export const GROWTH_INTIMACY: GrowthConfig = {
  key: "intimacy",
  stages: [
    { threshold: 0, name: "幼猫", milestone: undefined },
    { threshold: 100, name: "朋友", milestone: "我们成为朋友啦！谢谢你陪伴我~" },
    { threshold: 350, name: "亲密伙伴", milestone: "我们已经是亲密伙伴了！" },
    { threshold: 800, name: "心灵契合", milestone: "心灵契合！我们之间有特别的缘分~" },
  ],
};

/** All default attributes bundled together */
export const DEFAULT_ATTRIBUTES: AttributeDef[] = [
  ATTR_MOOD,
  ATTR_HUNGER,
  ATTR_HEALTH,
];
