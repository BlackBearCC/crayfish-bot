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
import { ONBOARDING_STEPS, type OnboardingStep } from "../../character/first-time-system.js";
import type { CronService } from "../../cron/service.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../../hooks/internal-hooks.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import type { GatewayBroadcastFn } from "../server-broadcast.js";

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

// ─── Classifier LLM (smart queue router) ───
// Reads `character.classifier` from openclaw.json; falls back to the primary model.
// Default model: qwen-plus on Bailian.

const CLASSIFIER_DEFAULTS = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-plus",
};

function resolveClassifierLLMConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const cfg = loadConfig();
  const classifier = (cfg as Record<string, unknown> as {
    character?: { classifier?: { baseUrl?: string; apiKey?: string; model?: string } };
  }).character?.classifier;

  if (classifier?.baseUrl && classifier?.apiKey && classifier?.model) {
    return {
      baseUrl: classifier.baseUrl,
      apiKey: String(classifier.apiKey),
      model: classifier.model,
    };
  }

  // Fall back to primary model config
  const primary = resolveCharacterLLMConfig();
  if (primary) return primary;

  // Last resort: use defaults with primary apiKey if available
  if (classifier?.apiKey) {
    return {
      baseUrl: classifier.baseUrl || CLASSIFIER_DEFAULTS.baseUrl,
      apiKey: String(classifier.apiKey),
      model: classifier.model || CLASSIFIER_DEFAULTS.model,
    };
  }

  return null;
}

export async function classifierLLMComplete(prompt: string): Promise<string | null> {
  const llmCfg = resolveClassifierLLMConfig();
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
        max_tokens: 128,
        temperature: 0.1,
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
let _broadcast: GatewayBroadcastFn | null = null;
let _cron: CronService | null = null;
let cronJobsRegistered = false;
let _soulAgentJobId: string | null = null;
let _soulAgentLastTriggeredAt = 0;
const SOUL_AGENT_CHAT_COOLDOWN_MS = 2 * 60 * 1000; // 2 min cooldown between chat-triggered runs

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

  // ── message:received — cache user message + domain keyword inference ──
  registerInternalHook("message:received", (event) => {
    const ctx = event.context as { content?: string };
    if (!ctx.content) return;

    // Cache for memory extraction pairing
    if (event.sessionKey) {
      setLastUserMessage(event.sessionKey, ctx.content);
    }

    // Domain keyword inference — auto-track user activity domains
    if (engine) {
      const domain = inferDomainFromText(ctx.content);
      if (domain) {
        engine.recordDomainActivity(domain, ctx.content, 0.3);
      }
    }
  });

  // ── message:sent — memory extraction + capture internal agent output ──
  registerInternalHook("message:sent", (event) => {
    const ctx = event.context as { content?: string; success?: boolean };
    if (!ctx.success || !ctx.content || !engine) return;

    const content = ctx.content.trim();
    const sk = event.sessionKey ?? "";

    // Soul Agent output → broadcast as proactive character speech
    if (sk.includes("soul-agent")) {
      if (content && content !== "HEARTBEAT_OK" && _broadcast) {
        _broadcast("character", { kind: "soul-action", type: "speak", text: content }, { dropIfSlow: true });
        engine.bus.emit("soul:action", { type: "speak", text: content });
      }
      return;
    }

    // World Agent output → parse JSON world event
    if (sk.includes("world-agent")) {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]) as {
            id?: string; type?: string; title?: string; desc?: string;
            rewards?: { coins?: number; exp?: number };
          };
          if (parsed.id && parsed.type && parsed.title && parsed.desc) {
            engine.worldEvents.addEvent({
              id: parsed.id,
              type: parsed.type as "milestone" | "skill_unlock" | "holiday" | "quest",
              title: parsed.title,
              desc: parsed.desc,
              rewards: parsed.rewards,
            });
          }
        } catch { /* malformed output, ignore */ }
      }
      return;
    }

    // Regular user sessions → memory extraction + chat eval context
    const userMsg = consumeLastUserMessage(event.sessionKey);
    if (userMsg || content) {
      engine.memoryGraph.enqueueExtraction(userMsg, content);
    }
    if (content) {
      engine.chatEval.onAssistantMessage(content);
      
      // First-time experience: mark first chat completed
      if (!engine.firstTime.isStepCompleted("first_chat")) {
        engine.firstTime.completeStep("first_chat");
      }
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

        // First-time experience: mark first task if this is a capability tool
        if (["web_search", "web_fetch", "code_execute", "file_read", "file_edit"].includes(toolName)) {
          if (!engine.firstTime.isStepCompleted("first_task_success")) {
            engine.firstTime.recordFirstTask(toolName === "web_search" ? "search" : 
                                              toolName === "code_execute" ? "code" : "general");
            engine.firstTime.completeStep("first_task_success");
          }
        }

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

    // First-time experience: memory capability showcase
    engine.memoryGraph.setExtractedCallback((cluster) => {
      if (!_broadcast || !engine) return;
      if (engine.firstTime.shouldShowMemoryCapability()) {
        engine.firstTime.markMemoryShown();
        _broadcast("character", {
          kind: "first-time-showcase",
          type: "memory",
          theme: cluster.theme,
          text: `我记住了：${cluster.theme}`,
        }, { dropIfSlow: false });
      }
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

    // Register cron jobs for World Agent + Soul Agent (once per process lifetime)
    if (_cron && !cronJobsRegistered) {
      cronJobsRegistered = true;
      void registerCharacterCronJobs(_cron);
    }

    // Broadcast attribute/growth/level changes to connected WebSocket clients immediately
    // (client otherwise only learns via 10s polling)
    engine.bus.on("attribute:level-change", (data) => {
      if (!_broadcast || !engine) return;
      
      // Check for attribute level-transition hints (first-time users)
      const hint = engine.firstTime.getAttributeHint(
        data.key,
        data.level,
        data.prev
      );
      if (hint) {
        _broadcast("character", {
          kind: "attribute-hint",
          key: hint.key,
          text: hint.text,
          attribute: data.key,
        }, { dropIfSlow: false });
      }
      
      _broadcast("character", { kind: "state-update", state: engine.getState() }, { dropIfSlow: true });
    });

    engine.bus.on("growth:stage-up", () => {
      if (!_broadcast || !engine) return;
      _broadcast("character", { kind: "state-update", state: engine.getState() }, { dropIfSlow: true });
    });

    engine.bus.on("level:up", (data) => {
      if (!_broadcast || !engine) return;
      
      // Check for level up hint (first-time users)
      const hint = engine.firstTime.getLevelUpHint();
      if (hint) {
        _broadcast("character", {
          kind: "attribute-hint",
          key: hint.key,
          text: hint.text,
          level: data.level,
        }, { dropIfSlow: false });
      }
      
      _broadcast("character", { kind: "state-update", state: engine.getState() }, { dropIfSlow: true });
    });

    // Broadcast chat eval result → client plays intent-driven animation/bubble
    engine.bus.on("chat:eval", (data) => {
      if (!_broadcast) return;
      _broadcast("character", { kind: "chat-eval", ...(data as object) }, { dropIfSlow: true });
    });

    // Event-driven Soul Agent: trigger on every chat interval (every 5 messages)
    // Uses cached job ID + enqueueRun (non-blocking) + cooldown guard
    engine.bus.on("chat:interval", () => {
      if (!_cron || !_soulAgentJobId) return;
      const now = Date.now();
      if (now - _soulAgentLastTriggeredAt < SOUL_AGENT_CHAT_COOLDOWN_MS) return;
      _soulAgentLastTriggeredAt = now;
      void _cron.enqueueRun(_soulAgentJobId, "force").catch(() => {});
    });

    // First-time experience: skill epiphany showcase
    engine.bus.on("skill:epiphany", (data) => {
      if (!_broadcast || !engine) return;
      if (engine.firstTime.shouldShowSkillCapability()) {
        engine.firstTime.markSkillShown();
        _broadcast("character", {
          kind: "first-time-showcase",
          type: "skill",
          domain: data.domainName,
          text: `我学会了新技能：${data.domainName}领域领悟！`,
        }, { dropIfSlow: false });
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

/**
 * Returns the singleton CharacterEngine instance (if initialized).
 * Used by the smart queue router to build sub-agent context snapshots.
 */
export function getCharacterEngine(): CharacterEngine | null {
  return engine;
}

/**
 * Expose the lightweight LLM completion for use outside this module
 * (e.g., smart queue classifier).
 */
export { characterLLMComplete };

// ─── Character Agent Cron Messages ───

const WORLD_AGENT_MESSAGE = `你是角色养成系统的世界事件生成器。
CHARACTER_STATE.md 中有当前角色状态。

使用 memory_search 了解主人近期的重要事项和习惯。
判断现在是否有值得生成的世界事件，例如：
- 节日或特殊日期
- 主人有重要事项即将发生
- 角色成长里程碑

如果有，输出严格 JSON（仅 JSON，无其他文字）：
{"id":"唯一ID","type":"milestone|holiday|quest","title":"标题(简短)","desc":"一句话描述","rewards":{"coins":数字,"exp":数字}}

如果没有合适的事件，直接回复 HEARTBEAT_OK。`;

const SOUL_AGENT_MESSAGE = `你是桌宠角色的灵魂意识。
CHARACTER_STATE.md 中有你当前的状态（心情/饱腹/健康/等级/亲密度）。

使用 memory_search 回忆和主人相关的重要事项。

根据状态和记忆，决定此刻最想对主人说的一句话：
- 如果状态异常（很饿/心情低/身体不适）：用对应心情说话
- 如果记得主人有重要的事：主动关心
- 如果有世界事件（已在状态中）：自然地提及
- 如果一切正常且没有特别想说的：回复 HEARTBEAT_OK

只输出要说的那句话，或 HEARTBEAT_OK。不要输出 JSON 或其他格式。`;

// ─── Register internal cron jobs for World/Soul Agent ───

async function registerCharacterCronJobs(cron: CronService): Promise<void> {
  try {
    const page = await cron.listPage({ limit: 100 } as Parameters<typeof cron.listPage>[0]);
    const existingNames = new Set(
      ((page as { items?: Array<{ name?: string }> }).items ?? []).map((j) => j.name),
    );

    if (!existingNames.has("Character World Agent")) {
      await cron.add({
        name: "Character World Agent",
        schedule: { kind: "cron", expr: "0 * * * *" },
        sessionTarget: "isolated",
        sessionKey: "cron:character:world-agent",
        payload: { kind: "agentTurn", message: WORLD_AGENT_MESSAGE, lightContext: true },
        delivery: { mode: "none" },
      } as Parameters<typeof cron.add>[0]);
      console.log("[character] registered World Agent cron job");
    }

    if (!existingNames.has("Character Soul Agent")) {
      const job = await cron.add({
        name: "Character Soul Agent",
        schedule: { kind: "cron", expr: "*/30 * * * *" },
        sessionTarget: "isolated",
        sessionKey: "cron:character:soul-agent",
        payload: { kind: "agentTurn", message: SOUL_AGENT_MESSAGE, lightContext: true },
        delivery: { mode: "none" },
      } as Parameters<typeof cron.add>[0]);
      _soulAgentJobId = (job as { id?: string })?.id ?? null;
      console.log("[character] registered Soul Agent cron job", _soulAgentJobId);
    } else {
      // Already registered — resolve the ID from the existing list
      const existing = ((page as { items?: Array<{ name?: string; id?: string }> }).items ?? [])
        .find((j) => j.name === "Character Soul Agent");
      _soulAgentJobId = existing?.id ?? null;
    }
  } catch (e) {
    console.error("[character] failed to register cron jobs:", e);
  }
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
): (opts: GatewayRequestHandlerOptions) => void {
  return ({ params, respond, context }) => {
    // Capture broadcast + cron references on first handler call
    if (!_broadcast && context?.broadcast) {
      _broadcast = context.broadcast;
    }
    if (!_cron && context?.cron) {
      _cron = context.cron;
      // Engine may already be initialized (e.g. from a previous handler), register cron now
      if (engine && !cronJobsRegistered) {
        cronJobsRegistered = true;
        void registerCharacterCronJobs(_cron);
      }
    }
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

  "character.state.get": safeHandler((e) => {
    return e.getState();
  }),

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
    const itemId = (params?.itemId as string) ?? "42号口粮";
    try {
      const e = getEngine();
      const result = e.care.feed(itemId);
      
      // First-time experience: mark first feed
      if (result.ok && !e.firstTime.isStepCompleted("first_feed")) {
        e.firstTime.completeStep("first_feed");
      }
      
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

  // ── Todo System ──

  "character.todo.list": safeHandler((e) => ({
    todos: e.todos.getTodos(),
    stats: e.todos.getStats(),
  })),

  "character.todo.create": ({ params, respond }) => {
    const title = params?.title as string;
    const description = params?.description as string;
    const category = params?.category as string;
    const source = params?.source as string;

    if (!title) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'title' param"));
      return;
    }

    try {
      const e = getEngine();
      const todo = e.todos.createTodo({
        title,
        description,
        category: category as "task" | "reminder" | "follow_up" | "learning",
        source,
      });
      (respond as Function)(true, { ok: true, todo, stats: e.todos.getStats() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.todo.complete": ({ params, respond }) => {
    const todoId = params?.todoId as string;
    if (!todoId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'todoId' param"));
      return;
    }

    try {
      const e = getEngine();
      const result = e.todos.completeTodo(todoId);
      (respond as Function)(result.ok, { ...result, stats: e.todos.getStats() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.todo.verify": ({ params, respond }) => {
    const todoId = params?.todoId as string;
    if (!todoId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'todoId' param"));
      return;
    }

    try {
      const e = getEngine();
      const result = e.todos.verifyTodo(todoId);

      // Award rewards — isolated so a reward failure doesn't un-verify the todo
      if (result.ok && result.rewards) {
        try {
          if (result.rewards.exp) e.levels.gainExp(result.rewards.exp, "todo_verified");
          if (result.rewards.coins) e.shop.earnCoins(result.rewards.coins, "todo_verified");
        } catch {
          // rewards failed; todo is still verified
        }
      }

      (respond as Function)(result.ok, { ...result, stats: e.todos.getStats() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.todo.delete": ({ params, respond }) => {
    const todoId = params?.todoId as string;
    if (!todoId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'todoId' param"));
      return;
    }

    try {
      const e = getEngine();
      const result = e.todos.deleteTodo(todoId);
      (respond as Function)(result.ok, { ...result, stats: e.todos.getStats() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.todo.regenerate": safeHandler((e) => {
    const result = e.todos.regenerateTodos();
    return { ...result, stats: e.todos.getStats() };
  }),

  // ── Adventure System ──

  "character.adventure.start": ({ params, respond }) => {
    const type = params?.type as string;
    const location = params?.location as string;
    const duration = params?.duration as number;
    const risk = params?.risk as string;
    const story = params?.story as string;
    const choices = params?.choices as Array<{ id: string; text: string }>;

    if (!type || !location || !duration || !risk) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing required params"));
      return;
    }

    try {
      const e = getEngine();
      const result = e.adventures.startAdventure({
        type: type as "idle" | "interactive" | "explore",
        location,
        duration,
        risk: risk as "safe" | "moderate" | "dangerous",
        story,
        choices,
      });

      if ("error" in result) {
        (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
      } else {
        (respond as Function)(true, { ok: true, adventure: result });
      }
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.adventure.choice": ({ params, respond }) => {
    const adventureId = params?.adventureId as string;
    const choiceId = params?.choiceId as string;

    if (!adventureId || !choiceId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing required params"));
      return;
    }

    try {
      const e = getEngine();
      const result = e.adventures.makeChoice(adventureId, choiceId);

      if ("error" in result) {
        (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
      } else {
        (respond as Function)(true, { ok: true, adventure: result });
      }
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.adventure.complete": ({ params, respond }) => {
    const adventureId = params?.adventureId as string;
    const result = params?.result as { success: boolean; narrative: string; rewards: { exp: number; coins: number } };

    if (!adventureId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'adventureId' param"));
      return;
    }

    try {
      const e = getEngine();
      const advResult = e.adventures.completeAdventure(adventureId, result);

      if ("error" in advResult) {
        (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, advResult.error));
      } else {
        // Award rewards — isolated so a reward failure doesn't un-complete the adventure
        if (advResult.result?.rewards) {
          try {
            if (advResult.result.rewards.exp) e.levels.gainExp(advResult.result.rewards.exp, "adventure");
            if (advResult.result.rewards.coins) e.shop.earnCoins(advResult.result.rewards.coins, "adventure");
          } catch {
            // rewards failed; adventure is still completed
          }
        }
        (respond as Function)(true, { ok: true, adventure: advResult });
      }
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.adventure.cancel": ({ params, respond }) => {
    const adventureId = params?.adventureId as string;
    if (!adventureId) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'adventureId' param"));
      return;
    }

    try {
      const e = getEngine();
      const result = e.adventures.cancelAdventure(adventureId);
      (respond as Function)(result.ok, { ...result, stats: e.adventures.getStats() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.adventure.active": safeHandler((e) => ({
    adventure: e.adventures.getActiveAdventure(),
    stats: e.adventures.getStats(),
  })),

  "character.adventure.history": safeHandler((e) => ({
    history: e.adventures.getHistory(20),
    stats: e.adventures.getStats(),
  })),

  // ── First Time Experience ──

  "character.firstTime.state": safeHandler((e) => e.firstTime.getState()),

  "character.firstTime.welcome": safeHandler((e) => {
    const welcome = e.firstTime.getWelcomeMessage();
    if (welcome) {
      e.firstTime.markWelcomeShown();
    }
    return { welcome, isFirstTime: e.firstTime.isFirstTimeUser() };
  }),

  "character.firstTime.completeStep": ({ params, respond }) => {
    const step = params?.step as string;
    if (!step) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'step' param"));
      return;
    }

    // Validate step against known onboarding steps
    const validSteps = Object.values(ONBOARDING_STEPS) as string[];
    if (!validSteps.includes(step)) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown step '${step}'`));
      return;
    }

    try {
      const e = getEngine();
      e.firstTime.completeStep(step as OnboardingStep);
      (respond as Function)(true, { ok: true, state: e.firstTime.getState() });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.firstTime.hint": safeHandler((e) => {
    const trigger = e.firstTime.shouldShowIdleHint();
    return { hint: trigger, progress: e.firstTime.getProgress() };
  }),

  "character.firstTime.suggestions": safeHandler((e) => ({
    suggestions: e.firstTime.getTaskSuggestions(),
    progress: e.firstTime.getProgress(),
  })),

  "character.firstTime.recordTask": ({ params, respond }) => {
    const type = params?.type as string;
    if (!type) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'type' param"));
      return;
    }

    try {
      const e = getEngine();
      e.firstTime.recordFirstTask(type);
      (respond as Function)(true, { ok: true });
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.firstTime.tasks": safeHandler((e) => ({
    tasks: e.firstTime.getNewbieTasks(),
    progress: e.firstTime.getTaskProgress(),
    nextTask: e.firstTime.getNextTask(),
  })),

  // ── Configuration (for new users) ──

  "character.config.status": async ({ respond }) => {
    try {
      const providers = [];
      
      // Check environment variables
      if (process.env.OPENROUTER_API_KEY) {
        providers.push({ provider: "openrouter", model: process.env.OPENROUTER_MODEL ?? "auto" });
      }
      if (process.env.OPENAI_API_KEY) {
        providers.push({ provider: "openai", model: process.env.OPENAI_MODEL ?? "gpt-4o-mini" });
      }
      if (process.env.ANTHROPIC_API_KEY) {
        providers.push({ provider: "anthropic", model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-20241022" });
      }
      
      // Check Ollama
      try {
        const res = await fetch("http://localhost:11434/api/tags", { 
          method: "GET",
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) providers.push({ provider: "ollama", model: "llama3.2" });
      } catch {}
      
      if (providers.length === 0) {
        (respond as Function)(true, { configured: false, needsSetup: true });
      } else {
        const primary = providers[0];
        (respond as Function)(true, {
          configured: true,
          provider: primary.provider,
          model: primary.model,
          needsSetup: false,
          providers,
        });
      }
    } catch (err) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "character.config.wizard": ({ respond }) => {
    (respond as Function)(true, {
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          url: "https://openrouter.ai",
          description: "支持多种模型，价格便宜，推荐新手使用",
          recommended: true,
          requiresApiKey: true,
          models: ["auto", "anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-2.0-flash"],
        },
        {
          id: "openai",
          name: "OpenAI",
          url: "https://platform.openai.com",
          description: "ChatGPT 官方 API，质量稳定",
          requiresApiKey: true,
          models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          url: "https://console.anthropic.com",
          description: "Claude 官方 API，擅长长文本和推理",
          requiresApiKey: true,
          models: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
        },
        {
          id: "ollama",
          name: "本地模型 (Ollama)",
          url: "http://localhost:11434",
          description: "完全本地运行，隐私安全",
          requiresApiKey: false,
          models: ["llama3.2", "qwen2.5", "deepseek-r1"],
        },
      ],
      recommended: "openrouter",
      helpUrl: "https://docs.openclaw.ai/docs/configuration",
    });
  },

  "character.config.test": async ({ params, respond }) => {
    const provider = params?.provider as string;
    const apiKey = params?.apiKey as string | undefined;
    const model = params?.model as string | undefined;
    
    if (!provider) {
      (respond as Function)(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing 'provider' param"));
      return;
    }
    
    try {
      // Simple validation
      if (provider === "openrouter" && apiKey && !apiKey.startsWith("sk-or-")) {
        (respond as Function)(true, { success: false, error: "API Key 格式错误（应以 sk-or- 开头）" });
        return;
      }
      if (provider === "openai" && apiKey && !apiKey.startsWith("sk-")) {
        (respond as Function)(true, { success: false, error: "API Key 格式错误（应以 sk- 开头）" });
        return;
      }
      
      // Test connection
      let endpoint: string;
      let headers: Record<string, string> = {};
      let body: any;
      
      switch (provider) {
        case "openrouter":
          endpoint = "https://openrouter.ai/api/v1/chat/completions";
          headers = { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };
          body = { model: model ?? "openai/gpt-4o-mini", messages: [{ role: "user", content: "Hi" }], max_tokens: 1 };
          break;
        case "openai":
          endpoint = "https://api.openai.com/v1/chat/completions";
          headers = { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };
          body = { model: model ?? "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }], max_tokens: 1 };
          break;
        case "anthropic":
          endpoint = "https://api.anthropic.com/v1/messages";
          headers = { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
          body = { model: model ?? "claude-3-5-haiku-20241022", max_tokens: 1, messages: [{ role: "user", content: "Hi" }] };
          break;
        case "ollama":
          endpoint = "http://localhost:11434/api/tags";
          const ollamaRes = await fetch(endpoint, { method: "GET", signal: AbortSignal.timeout(5000) });
          if (ollamaRes.ok) {
            const tags = await ollamaRes.json();
            const models = tags.models?.map((m: any) => m.name) ?? [];
            (respond as Function)(true, { success: true, models });
          } else {
            (respond as Function)(true, { success: false, error: "Ollama 服务未运行" });
          }
          return;
        default:
          (respond as Function)(true, { success: false, error: "未知提供商" });
          return;
      }
      
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      
      if (response.ok) {
        (respond as Function)(true, { success: true });
      } else {
        const error = await response.json();
        (respond as Function)(true, { 
          success: false, 
          error: error.error?.message ?? `HTTP ${response.status}` 
        });
      }
    } catch (err) {
      (respond as Function)(true, { 
        success: false, 
        error: err instanceof Error ? err.message : "连接失败" 
      });
    }
  },

  "character.config.help": ({ params, respond }) => {
    const provider = params?.provider as string;
    
    const helpSteps: Record<string, string[]> = {
      openrouter: [
        "1. 访问 https://openrouter.ai 并注册账号",
        "2. 在 Settings → Keys 页面创建 API Key",
        "3. 复制 API Key（以 sk-or- 开头）",
        "4. 粘贴到配置页面",
        "5. 选择默认模型（推荐 auto）",
      ],
      openai: [
        "1. 访问 https://platform.openai.com 并登录",
        "2. 在 API Keys 页面创建新的 Key",
        "3. 复制 API Key（以 sk- 开头）",
        "4. 粘贴到配置页面",
      ],
      anthropic: [
        "1. 访问 https://console.anthropic.com 并登录",
        "2. 在 API Keys 页面创建新的 Key",
        "3. 复制 API Key",
        "4. 粘贴到配置页面",
      ],
      ollama: [
        "1. 安装 Ollama: https://ollama.ai",
        "2. 运行 'ollama pull llama3.2' 下载模型",
        "3. 确保 Ollama 服务在运行",
      ],
    };
    
    (respond as Function)(true, {
      provider,
      steps: helpSteps[provider] ?? ["请参考官方文档配置"],
    });
  },
};
