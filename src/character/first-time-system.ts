/**
 * Character Engine — FirstTimeSystem
 *
 * Manages first-time user experience:
 * - Detects if user is new
 * - Tracks onboarding progress
 * - Provides hints and guidance
 *
 * Design principles:
 * - AI capability first, pet cuteness second
 * - Show value in first 30 seconds
 * - Guide user to complete first task successfully
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";

// ─── Constants ───

/** Steps in the onboarding journey */
export const ONBOARDING_STEPS = {
  WELCOME_SHOWN: "welcome_shown",           // 开场白已显示
  FIRST_CHAT: "first_chat",                  // 第一次聊天
  FIRST_TASK_SUCCESS: "first_task_success",  // 第一个任务成功
  FIRST_FEED: "first_feed",                  // 第一次喂食
  ONLINE_10MIN: "online_10min",              // 在线陪伴10分钟
  MEMORY_SHOWN: "memory_shown",              // 记忆能力展示
  SKILL_SHOWN: "skill_shown",                // 技能成长展示
  ONBOARDING_COMPLETE: "onboarding_complete", // 引导完成
} as const;

export type OnboardingStep = typeof ONBOARDING_STEPS[keyof typeof ONBOARDING_STEPS];

/** Hint triggers */
export const HINT_TRIGGERS = {
  IDLE_AFTER_WELCOME: "idle_after_welcome",     // 开场后闲置
  FIRST_HUNGER_LOW: "first_hunger_low",          // 第一次饥饿
  FIRST_TASK_COMPLETE: "first_task_complete",    // 第一个任务完成
  FIRST_MEMORY: "first_memory",                  // 第一次记忆
  FIRST_SKILL: "first_skill",                    // 第一个技能
  IDLE_LONG: "idle_long",                        // 长时间闲置
} as const;

export type HintTrigger = typeof HINT_TRIGGERS[keyof typeof HINT_TRIGGERS];

// ─── Types ───

export interface HintContent {
  trigger: HintTrigger;
  text: string;
  delayMs?: number;     // 延迟显示
  once?: boolean;       // 只显示一次
  priority?: number;    // 优先级，高优先级先显示
}

export interface FirstTimeState {
  /** Whether this is a first-time user */
  isFirstTime: boolean;
  /** Completed onboarding steps */
  completedSteps: OnboardingStep[];
  /** Hints and attribute hints that have been shown (unified string set) */
  shownHints: string[];
  /** First task type attempted */
  firstTaskType?: string;
  /** Timestamp of first launch */
  firstLaunchAt?: number;
  /** Timestamp of onboarding completion */
  completedAt?: number;
  /** Welcome message index (for variety) */
  welcomeIndex?: number;
}

// ─── Welcome Messages ───

/**
 * Opening messages that showcase AI capabilities + cuteness.
 * Design: Capability first, cuteness to enhance affinity.
 * Goal: Make user want to try in first 10 seconds.
 */
export const WELCOME_MESSAGES = [
  {
    text: "你好呀！我是你的 AI 小伙伴~ 🐾 我可以帮你查资料、写代码、设置提醒，还能记住你说的所有事情！你想让我帮你做什么？",
    capabilities: ["查资料", "写代码", "设置提醒", "记住事情"],
  },
  {
    text: "嗨！我是一只数字小猫爪~ 我会搜索信息、写代码、设置提醒，还会越来越多技能！有什么想让我帮忙的？✨",
    capabilities: ["搜索信息", "写代码", "设置提醒", "学习技能"],
  },
  {
    text: "终于见到你啦！我是你的智能助手~ 我能帮你处理各种任务，而且会记住我们的每一次对话，越来越懂你！试试让我做点什么？😊",
    capabilities: ["处理任务", "记住对话", "越来越懂你"],
  },
];

// ─── Hint Contents ───

/**
 * Contextual hints to guide users.
 * Design: Short, cute, non-intrusive.
 */
export const HINT_CONTENTS: HintContent[] = [
  // 开场后闲置提示
  {
    trigger: HINT_TRIGGERS.IDLE_AFTER_WELCOME,
    text: "想试试吗？问我任何问题~",
    delayMs: 10000,
    once: true,
    priority: 1,
  },
  // 第一次饥饿提示
  {
    trigger: HINT_TRIGGERS.FIRST_HUNGER_LOW,
    text: "我饿了...能喂我吗？",
    delayMs: 0,
    once: true,
    priority: 10,
  },
  // 第一个任务完成
  {
    trigger: HINT_TRIGGERS.FIRST_TASK_COMPLETE,
    text: "搞定啦！还有什么要我帮忙的？",
    delayMs: 2000,
    once: true,
    priority: 5,
  },
  // 第一次记忆
  {
    trigger: HINT_TRIGGERS.FIRST_MEMORY,
    text: "我记住啦！",
    delayMs: 1000,
    once: true,
    priority: 3,
  },
  // 第一个技能
  {
    trigger: HINT_TRIGGERS.FIRST_SKILL,
    text: "我学会新技能啦！",
    delayMs: 1000,
    once: true,
    priority: 4,
  },
  // 长时间闲置
  {
    trigger: HINT_TRIGGERS.IDLE_LONG,
    text: "我在呢~ 有事找我哦",
    delayMs: 0,
    once: false,
    priority: 0,
  },
];

// ─── Attribute Threshold Hints ───

/**
 * Attribute level-transition hints.
 * Triggered when an attribute transitions into a specific level for the first time.
 * Keys use format: `{attribute}_{level}` matching the level names in presets.ts.
 * Design: Short, cute, non-intrusive.
 */
export const ATTRIBUTE_HINTS = {
  hunger_hungry: {
    text: "我有点饿了~",
    once: true,
  },
  hunger_starving: {
    text: "好饿...先喂喂我吧",
    once: true,
  },
  mood_sad: {
    text: "我有点不开心...陪我玩玩？",
    once: true,
  },
  health_sick: {
    text: "我不舒服...能给我吃点药吗？",
    once: true,
  },
  attribute_full: {
    text: "状态恢复啦！活力满满~",
    once: true,
  },
  first_level_up: {
    text: "升级啦！✨ 我变强了！",
    once: true,
  },
} as const;

export type AttributeHintKey = keyof typeof ATTRIBUTE_HINTS;

// ─── Newbie Tasks ───

/** Newbie task definition */
export interface NewbieTask {
  id: string;
  title: string;
  description: string;
  hint: string;
  step: OnboardingStep;
  rewards: {
    exp?: number;
    coins?: number;
    itemId?: string;
  };
}

/** Day 1 tutorial tasks */
export const DAY1_TASKS: NewbieTask[] = [
  {
    id: "task-first-chat",
    title: "初次见面",
    description: "和宠物聊第一句话",
    hint: "试着和我说说话~",
    step: "first_chat" as OnboardingStep,
    rewards: { exp: 5, coins: 10 },
  },
  {
    id: "task-first-search",
    title: "搜索小能手",
    description: "让宠物帮你查一个问题",
    hint: "想查什么？问我试试！",
    step: "first_task_success" as OnboardingStep,
    rewards: { exp: 10, coins: 20 },
  },
  {
    id: "task-first-feed",
    title: "照顾新手",
    description: "给宠物喂第一次食",
    hint: "我饿了...喂我吃东西吧",
    step: "first_feed" as OnboardingStep,
    rewards: { exp: 5, coins: 15 },
  },
  {
    id: "task-online-10min",
    title: "陪伴时光",
    description: "在线陪伴宠物 10 分钟",
    hint: "多陪我一会儿嘛~",
    step: "online_10min" as OnboardingStep,
    rewards: { exp: 15, coins: 30 },
  },
];

// ─── First Time Tasks ───

/**
 * Suggested first tasks to guide users.
 * Design: Easy to succeed, showcase core capabilities.
 */
export const FIRST_TASK_SUGGESTIONS = [
  {
    type: "search",
    examples: ["今天天气怎么样", "最近有什么新闻", "帮我查一下..."],
    capability: "搜索信息",
    hint: "想查什么？问我试试！",
  },
  {
    type: "reminder",
    examples: ["提醒我明天开会", "记住我有个重要会议", "帮我记住..."],
    capability: "设置提醒",
    hint: "有什么要记住的？交给我！",
  },
  {
    type: "chat",
    examples: ["你好", "你是谁", "你能做什么"],
    capability: "聊天互动",
    hint: "随便聊聊也可以哦~",
  },
  {
    type: "code",
    examples: ["帮我写个函数", "这段代码有问题吗", "解释一下这个..."],
    capability: "编程帮助",
    hint: "有代码问题？我可以帮忙看看！",
  },
];

// ─── System ───

export class FirstTimeSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _state: FirstTimeState;
  private _lastActivityAt: number = Date.now();

  constructor(bus: EventBus, store: PersistenceStore) {
    this._bus = bus;
    this._store = store;
    this._state = this._load();
  }

  // ─── Core Queries ───

  /** Check if this is a first-time user */
  isFirstTimeUser(): boolean {
    return this._state.isFirstTime;
  }

  /** Check if a step is completed */
  isStepCompleted(step: OnboardingStep): boolean {
    return this._state.completedSteps.includes(step);
  }

  /** Get onboarding progress (0-1) */
  getProgress(): number {
    const totalSteps = Object.keys(ONBOARDING_STEPS).length - 1; // exclude ONBOARDING_COMPLETE
    const completed = this._state.completedSteps.filter(
      s => s !== ONBOARDING_STEPS.ONBOARDING_COMPLETE
    ).length;
    return Math.min(1, completed / totalSteps);
  }

  /** Get state for client */
  getState(): FirstTimeState {
    return { ...this._state };
  }

  // ─── Welcome Message ───

  /** Get welcome message for first-time user */
  getWelcomeMessage(): { text: string; capabilities: string[] } | null {
    if (this.isStepCompleted(ONBOARDING_STEPS.WELCOME_SHOWN)) {
      return null;
    }

    // Select a welcome message (rotate for variety)
    const index = this._state.welcomeIndex ?? Math.floor(Math.random() * WELCOME_MESSAGES.length);
    this._state.welcomeIndex = index;
    this._save();

    return WELCOME_MESSAGES[index];
  }

  // ─── Step Management ───

  /** Mark a step as completed */
  completeStep(step: OnboardingStep): void {
    if (this._state.completedSteps.includes(step)) return;

    this._state.completedSteps.push(step);

    // Check if onboarding is complete (all core steps done)
    const requiredSteps = [
      ONBOARDING_STEPS.WELCOME_SHOWN,
      ONBOARDING_STEPS.FIRST_CHAT,
      ONBOARDING_STEPS.FIRST_TASK_SUCCESS,
      ONBOARDING_STEPS.FIRST_FEED,
    ];

    if (requiredSteps.every(s => this._state.completedSteps.includes(s))) {
      if (!this._state.completedSteps.includes(ONBOARDING_STEPS.ONBOARDING_COMPLETE)) {
        this._state.completedSteps.push(ONBOARDING_STEPS.ONBOARDING_COMPLETE);
        this._state.completedAt = Date.now();
        this._state.isFirstTime = false;
      }
    }

    this._save();
  }

  /** Mark welcome as shown */
  markWelcomeShown(): void {
    this.completeStep(ONBOARDING_STEPS.WELCOME_SHOWN);
  }

  /** Record first task type */
  recordFirstTask(type: string): void {
    if (!this._state.firstTaskType) {
      this._state.firstTaskType = type;
      this._save();
    }
  }

  // ─── Hint System ───

  /** Get a hint for the current context */
  getHint(trigger: HintTrigger): HintContent | null {
    // Check if already shown and once-only
    if (this._state.shownHints.includes(trigger)) {
      const hint = HINT_CONTENTS.find(h => h.trigger === trigger);
      if (hint?.once) return null;
    }

    const hint = HINT_CONTENTS.find(h => h.trigger === trigger);
    if (!hint) return null;

    // Mark as shown
    if (!this._state.shownHints.includes(trigger)) {
      this._state.shownHints.push(trigger);
      this._save();
    }

    return hint;
  }

  /** Check if should show idle hint */
  shouldShowIdleHint(): HintContent | null {
    const idleMs = Date.now() - this._lastActivityAt;

    // After welcome, idle for 10 seconds
    if (
      this.isStepCompleted(ONBOARDING_STEPS.WELCOME_SHOWN) &&
      !this.isStepCompleted(ONBOARDING_STEPS.FIRST_CHAT) &&
      idleMs > 10000
    ) {
      return this.getHint(HINT_TRIGGERS.IDLE_AFTER_WELCOME);
    }

    // Long idle (5 minutes)
    if (idleMs > 5 * 60 * 1000) {
      return this.getHint(HINT_TRIGGERS.IDLE_LONG);
    }

    return null;
  }

  /** Update activity timestamp */
  updateActivity(): void {
    this._lastActivityAt = Date.now();
  }

  // ─── Task Suggestions ───

  /** Get task suggestions for new user */
  getTaskSuggestions(): typeof FIRST_TASK_SUGGESTIONS {
    if (!this._state.isFirstTime) return [];
    if (this.isStepCompleted(ONBOARDING_STEPS.FIRST_TASK_SUCCESS)) return [];
    return FIRST_TASK_SUGGESTIONS;
  }

  /** Get hint for a specific task type */
  getTaskHintByType(type: string): string | null {
    const task = FIRST_TASK_SUGGESTIONS.find(t => t.type === type);
    return task?.hint ?? null;
  }

  // ─── Memory & Skill Showcase ───

  /** Should show memory capability */
  shouldShowMemoryCapability(): boolean {
    return (
      this._state.isFirstTime &&
      !this.isStepCompleted(ONBOARDING_STEPS.MEMORY_SHOWN) &&
      this.isStepCompleted(ONBOARDING_STEPS.FIRST_CHAT)
    );
  }

  /** Mark memory capability as shown */
  markMemoryShown(): void {
    this.completeStep(ONBOARDING_STEPS.MEMORY_SHOWN);
  }

  /** Should show skill capability */
  shouldShowSkillCapability(): boolean {
    return (
      this._state.isFirstTime &&
      !this.isStepCompleted(ONBOARDING_STEPS.SKILL_SHOWN) &&
      this.isStepCompleted(ONBOARDING_STEPS.FIRST_TASK_SUCCESS)
    );
  }

  /** Mark skill capability as shown */
  markSkillShown(): void {
    this.completeStep(ONBOARDING_STEPS.SKILL_SHOWN);
  }

  // ─── Attribute Threshold Hints ───

  /**
   * Check and get attribute level-transition hint.
   * Uses level names (from presets.ts) instead of numeric thresholds,
   * so hints stay correct even if attribute thresholds are customized.
   */
  getAttributeHint(
    key: string,
    currentLevel: string,
    prevLevel: string
  ): { key: AttributeHintKey; text: string } | null {
    if (!this._state.isFirstTime) return null;
    if (currentLevel === prevLevel) return null;

    // Map: attribute + level → hint key
    const LEVEL_HINT_MAP: Record<string, AttributeHintKey> = {
      "hunger:hungry": "hunger_hungry",
      "hunger:starving": "hunger_starving",
      "mood:sad": "mood_sad",
      "health:sick": "health_sick",
    };

    // Check for recovery (any attribute going to a high level)
    const RECOVERY_LEVELS: Record<string, string[]> = {
      hunger: ["full"],
      mood: ["joyful"],
      health: ["healthy"],
    };

    const hintKey = LEVEL_HINT_MAP[`${key}:${currentLevel}`];
    if (hintKey && !this._isAttributeHintShown(hintKey)) {
      this._markAttributeHintShown(hintKey);
      return { key: hintKey, text: ATTRIBUTE_HINTS[hintKey].text };
    }

    // Recovery hint (attribute restored to top level)
    const recoveryLevels = RECOVERY_LEVELS[key];
    if (recoveryLevels?.includes(currentLevel) && !this._isAttributeHintShown("attribute_full")) {
      this._markAttributeHintShown("attribute_full");
      return { key: "attribute_full", text: ATTRIBUTE_HINTS.attribute_full.text };
    }

    return null;
  }

  /** Get level up hint */
  getLevelUpHint(): { key: AttributeHintKey; text: string } | null {
    if (!this._state.isFirstTime) return null;
    if (this._isAttributeHintShown("first_level_up")) return null;
    this._markAttributeHintShown("first_level_up");
    return { key: "first_level_up", text: ATTRIBUTE_HINTS.first_level_up.text };
  }

  private _isAttributeHintShown(key: AttributeHintKey): boolean {
    return this._state.shownHints.includes(key);
  }

  private _markAttributeHintShown(key: AttributeHintKey): void {
    if (!this._state.shownHints.includes(key)) {
      this._state.shownHints.push(key);
      this._save();
    }
  }

  // ─── Newbie Tasks ───

  /** Get all newbie tasks with completion status */
  getNewbieTasks(): (NewbieTask & { completed: boolean })[] {
    return DAY1_TASKS.map(task => ({
      ...task,
      completed: this.isStepCompleted(task.step),
    }));
  }

  /** Get next incomplete task */
  getNextTask(): (NewbieTask & { completed: boolean }) | null {
    const incomplete = this.getNewbieTasks().filter(t => !t.completed);
    return incomplete.length > 0 ? incomplete[0] : null;
  }

  /** Get task progress (0-1) */
  getTaskProgress(): number {
    const tasks = this.getNewbieTasks();
    const completed = tasks.filter(t => t.completed).length;
    return tasks.length > 0 ? completed / tasks.length : 0;
  }

  /** Get hint for current task */
  getTaskHint(): string | null {
    const nextTask = this.getNextTask();
    return nextTask?.hint ?? null;
  }

  // ─── Persistence ───

  private _load(): FirstTimeState {
    const saved = this._store.load("first-time");
    if (saved) {
      return saved as unknown as FirstTimeState;
    }

    // New user
    return {
      isFirstTime: true,
      completedSteps: [],
      shownHints: [],
      firstLaunchAt: Date.now(),
    };
  }

  private _save(): void {
    this._store.save("first-time", {
      ...this._state,
      updatedAt: Date.now(),
    });
  }
}