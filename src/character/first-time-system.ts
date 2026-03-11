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
  /** Hints that have been shown */
  shownHints: HintTrigger[];
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
 * Opening messages that showcase AI capabilities.
 * Design: Not cute talk, but capability showcase.
 * Goal: Make user want to try in first 10 seconds.
 */
export const WELCOME_MESSAGES = [
  {
    text: "你好！我是你的 AI 小伙伴~ 我可以帮你查资料、写代码、设置提醒，还能记住你说的所有事情！你想让我帮你做什么？",
    capabilities: ["查资料", "写代码", "设置提醒", "记住事情"],
  },
  {
    text: "嗨！我是你的智能助手~ 我会搜索信息、分析问题、管理日程，还会越来越懂你！有什么想让我帮忙的？",
    capabilities: ["搜索信息", "分析问题", "管理日程", "学习成长"],
  },
  {
    text: "你好呀！我是你的 AI 伙伴~ 我能帮你处理各种任务，而且会记住我们的每一次对话，越来越了解你！试试让我做点什么？",
    capabilities: ["处理任务", "记住对话", "越来越懂你"],
  },
];

// ─── Hint Contents ───

/**
 * Contextual hints to guide users.
 * Design: Non-blocking, helpful, timely.
 */
export const HINT_CONTENTS: HintContent[] = [
  // 开场后闲置提示
  {
    trigger: HINT_TRIGGERS.IDLE_AFTER_WELCOME,
    text: "想试试吗？可以问我任何问题~",
    delayMs: 10000,
    once: true,
    priority: 1,
  },
  // 第一次饥饿提示
  {
    trigger: HINT_TRIGGERS.FIRST_HUNGER_LOW,
    text: "我有点饿了...能喂我吃点东西吗？点击喂食按钮或者对我说'喂你吃东西'~",
    delayMs: 0,
    once: true,
    priority: 10,
  },
  // 第一个任务完成
  {
    trigger: HINT_TRIGGERS.FIRST_TASK_COMPLETE,
    text: "我做到了！还有什么要我帮忙的吗？",
    delayMs: 2000,
    once: true,
    priority: 5,
  },
  // 第一次记忆
  {
    trigger: HINT_TRIGGERS.FIRST_MEMORY,
    text: "我记住了！以后随时可以问我~",
    delayMs: 1000,
    once: true,
    priority: 3,
  },
  // 第一个技能
  {
    trigger: HINT_TRIGGERS.FIRST_SKILL,
    text: "我学会了新技能！我会越来越厉害的~",
    delayMs: 1000,
    once: true,
    priority: 4,
  },
  // 长时间闲置
  {
    trigger: HINT_TRIGGERS.IDLE_LONG,
    text: "我在这里~ 有什么需要帮忙的吗？",
    delayMs: 0,
    once: false,
    priority: 0,
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

    // Check if onboarding is complete
    const requiredSteps = [
      ONBOARDING_STEPS.WELCOME_SHOWN,
      ONBOARDING_STEPS.FIRST_CHAT,
      ONBOARDING_STEPS.FIRST_TASK_SUCCESS,
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
  getTaskHint(type: string): string | null {
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