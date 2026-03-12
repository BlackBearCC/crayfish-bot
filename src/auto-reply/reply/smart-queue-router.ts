/**
 * Smart Queue Router — classifies incoming messages while the main agent is
 * busy and either enqueues them (steer) or handles via MiniAgent (parallel).
 *
 * Flow:
 *   1. LLM classifier decides: steer (related to current task) / parallel (new topic)
 *   2. steer  → falls back to enqueueFollowupRun (original serial queue)
 *   3. parallel → buildParallelContextSnapshot + runMiniAgent + routeReply (direct, no announce)
 */

import crypto from "node:crypto";
import { runMiniAgent } from "../../agents/mini-agent.js";
import { classifierLLMComplete } from "../../gateway/server-methods/character.js";
import { logVerbose } from "../../globals.js";
import { getLogger } from "../../logging/logger.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { buildParallelContextSnapshot } from "./parallel-context.js";
import { enqueueFollowupRun, type FollowupRun, type QueueSettings } from "./queue.js";
import { readRecentSessionMessages } from "./parallel-context.js";
import { routeReply } from "./route-reply.js";
import { loadConfig } from "../../config/config.js";

// ─── Types ───

export type SmartRouteResult = "steer-enqueued" | "parallel-spawned" | "fallback-enqueued";

// ─── LLM classifier ───

async function classifyMessage(params: {
  newMessage: string;
  sessionFile: string;
}): Promise<"steer" | "parallel"> {
  const { newMessage, sessionFile } = params;

  // Grab last 3 user messages for classifier context (assistant messages excluded to avoid content pollution)
  const recent = await readRecentSessionMessages(sessionFile, 5);
  const recentUserMsgs = recent
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.text);

  const historyLines = recentUserMsgs.length > 0
    ? recentUserMsgs.map((t, i) => `用户消息${i + 1}: ${t}`).join("\n")
    : "（无历史记录）";

  const prompt = `你是消息路由分类器，判断新消息应"等待当前任务完成后处理"还是"立即独立处理"。

用户最近消息记录（最多3条，助手正在处理中）：
${historyLines}

用户新消息: ${newMessage}

判断规则：
- steer：仅当历史消息显示用户正在与助手协作执行具体任务（写代码、修改文件、分析数据、搜索等），且新消息是对该任务的直接补充/修正/催促/追问
- parallel：其他所有情况，包括日常聊天、问候、闲聊、新话题、角色扮演对话、无明确执行中任务时的任何消息

只返回 JSON，不要解释。示例：{"route":"parallel"}`;

  const log = getLogger();
  log.info(
    {
      message: `[smart-router] classify prompt snapshot | newMessage="${newMessage.slice(0, 100)}" recentUserMsgs=${JSON.stringify(recentUserMsgs.map(t => t.slice(0, 80)))}`,
    },
    "smart-router",
  );

  try {
    const raw = await classifierLLMComplete(prompt);
    if (!raw) {
      log.info({ message: "[smart-router] classify result: fallback→steer (empty response — no classifier LLM configured?)" }, "smart-router");
      return "steer";
    }
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) {
      log.info({ message: `[smart-router] classify result: fallback→steer (no JSON) raw="${raw.slice(0, 200)}"` }, "smart-router");
      return "steer";
    }
    const parsed = JSON.parse(match[0]) as { route?: string };
    const route = parsed.route === "parallel" ? "parallel" : "steer";
    log.info({ message: `[smart-router] classify result: ${route} | raw="${raw.slice(0, 200)}"` }, "smart-router");
    return route;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info({ message: `[smart-router] classify result: fallback→steer (error: ${msg})` }, "smart-router");
    return "steer";
  }
}

// ─── MiniAgent direct reply ───

async function sendDirectReply(params: {
  followupRun: FollowupRun;
  contextSnapshot: string;
}): Promise<{ ok: boolean }> {
  const { followupRun, contextSnapshot } = params;
  const log = getLogger();

  log.info(
    { message: `[smart-router] MiniAgent START | prompt="${followupRun.prompt.slice(0, 80)}..." sessionKey=${followupRun.run.sessionKey}` },
    "smart-router"
  );

  try {
    // Run MiniAgent to get response
    log.info({ message: `[smart-router] MiniAgent calling runMiniAgent...` }, "smart-router");
    const result = await runMiniAgent({
      userPrompt: followupRun.prompt,
      contextSnapshot,
      mirrorToSession: followupRun.run.sessionFile
        ? {
            sessionFile: followupRun.run.sessionFile,
            sessionKey: followupRun.run.sessionKey,
          }
        : undefined,
    });

    log.info(
      { message: `[smart-router] MiniAgent result | ok=${result.ok} textLen=${result.text?.length ?? 0}` },
      "smart-router"
    );

    if (!result.ok || !result.text) {
      log.info({ message: `[smart-router] MiniAgent failed or empty response` }, "smart-router");
      return { ok: false };
    }

    // Route reply directly to user
    const payload: ReplyPayload = {
      text: result.text,
    };

    log.info(
      { message: `[smart-router] routeReply START | channel=${followupRun.originatingChannel || "webchat"} to=${followupRun.originatingTo || ""}` },
      "smart-router"
    );

    const cfg = loadConfig();
    await routeReply({
      payload,
      channel: followupRun.originatingChannel || "webchat",
      to: followupRun.originatingTo || "",
      accountId: followupRun.originatingAccountId,
      threadId: followupRun.originatingThreadId != null ? String(followupRun.originatingThreadId) : undefined,
      sessionKey: followupRun.run.sessionKey,
      cfg,
      mirror: true,
    });

    log.info({ message: `[smart-router] routeReply DONE` }, "smart-router");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info({ message: `[smart-router] MiniAgent ERROR: ${msg}` }, "smart-router");
    return { ok: false };
  }
}

// ─── Main entry ───

export async function smartRouteOrEnqueue(params: {
  queueKey: string;
  followupRun: FollowupRun;
  resolvedQueue: QueueSettings;
  opts?: GetReplyOptions;
}): Promise<SmartRouteResult> {
  const { queueKey, followupRun, resolvedQueue } = params;
  const log = getLogger();

  log.info(
    { message: `[smart-router] ENTER | queueKey=${queueKey} mode=${resolvedQueue.mode} prompt="${followupRun.prompt.slice(0, 50)}..."` },
    "smart-router"
  );

  // Non-smart modes: skip classifier, always use serial queue
  if (resolvedQueue.mode !== "smart") {
    log.info({ message: `[smart-router] non-smart mode (${resolvedQueue.mode}) → steer-enqueued` }, "smart-router");
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    return "steer-enqueued";
  }

  // Step 1: Classify (default to steer when uncertain — safe serial queue fallback)
  log.info({ message: `[smart-router] Step 1: classifyMessage...` }, "smart-router");
  let route: "steer" | "parallel";
  try {
    route = await classifyMessage({
      newMessage: followupRun.prompt,
      sessionFile: followupRun.run.sessionFile,
    });
  } catch {
    // Classification failed — default to steer (serial queue)
    log.info({ message: `[smart-router] classify failed → default steer` }, "smart-router");
    route = "steer";
  }
  log.info({ message: `[smart-router] Step 1 done: route=${route}` }, "smart-router");

  // Step 2: Route
  if (route === "steer") {
    log.info({ message: `[smart-router] Step 2: route=steer → enqueueFollowupRun` }, "smart-router");
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    return "steer-enqueued";
  }

  // Step 3: Build context + run MiniAgent for direct reply
  log.info({ message: `[smart-router] Step 3: route=parallel → build context...` }, "smart-router");
  const contextSnapshot = await buildParallelContextSnapshot({
    sessionFile: followupRun.run.sessionFile,
  });
  log.info({ message: `[smart-router] context built, calling sendDirectReply...` }, "smart-router");

  const result = await sendDirectReply({
    followupRun,
    contextSnapshot,
  });

  if (!result.ok) {
    // MiniAgent failed — fall back to serial queue
    log.info({ message: `[smart-router] sendDirectReply failed → fallback to enqueueFollowupRun` }, "smart-router");
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    return "fallback-enqueued";
  }

  log.info({ message: `[smart-router] DONE: parallel-spawned (MiniAgent direct reply)` }, "smart-router");
  return "parallel-spawned";
}
