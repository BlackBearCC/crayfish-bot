/**
 * Smart Queue Router — classifies incoming messages while the main agent is
 * busy and either enqueues them (steer) or spawns a parallel sub-agent.
 *
 * Flow:
 *   1. LLM classifier decides: steer (related to current task) / parallel (new topic)
 *   2. steer  → falls back to enqueueFollowupRun (original serial queue)
 *   3. parallel → buildParallelContextSnapshot + callGateway({method:"agent"})
 */

import crypto from "node:crypto";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import { callGateway } from "../../gateway/call.js";
import { characterLLMComplete } from "../../gateway/server-methods/character.js";
import { logVerbose } from "../../globals.js";
import type { GetReplyOptions } from "../types.js";
import { buildParallelContextSnapshot } from "./parallel-context.js";
import { enqueueFollowupRun, type FollowupRun, type QueueSettings } from "./queue.js";
import { readRecentSessionMessages } from "./parallel-context.js";

// ─── Types ───

export type SmartRouteResult = "steer-enqueued" | "parallel-spawned" | "fallback-enqueued";

// ─── LLM classifier ───

async function classifyMessage(params: {
  newMessage: string;
  sessionFile: string;
}): Promise<"steer" | "parallel"> {
  const { newMessage, sessionFile } = params;

  // Grab last 1 turn for classifier context (lightweight)
  const recent = await readRecentSessionMessages(sessionFile, 1);
  const lastUser = recent.find((m) => m.role === "user")?.text ?? "";
  const lastAssistant = recent.find((m) => m.role === "assistant")?.text ?? "";

  const prompt = `你是消息分类器。判断用户新消息是否与当前正在执行的任务相关。

当前任务上下文（最近一轮对话）：
用户: ${lastUser}
助手: ${lastAssistant}（正在执行中...）

用户新消息: ${newMessage}

如果新消息是对当前任务的补充、修正、催促或追问，返回 {"route":"steer"}
如果新消息是独立的新话题、闲聊、或新任务，返回 {"route":"parallel"}

只返回 JSON，不要解释。`;

  try {
    const raw = await characterLLMComplete(prompt);
    if (!raw) return "steer"; // Default to safe fallback
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) return "steer";
    const parsed = JSON.parse(match[0]) as { route?: string };
    if (parsed.route === "parallel") return "parallel";
    return "steer";
  } catch {
    return "steer";
  }
}

// ─── Sub-agent spawn ───

async function spawnParallelSubagent(params: {
  followupRun: FollowupRun;
  contextSnapshot: string;
}): Promise<{ runId: string } | null> {
  const { followupRun, contextSnapshot } = params;

  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: followupRun.prompt,
        channel: followupRun.originatingChannel,
        to: followupRun.originatingTo,
        accountId: followupRun.originatingAccountId,
        threadId:
          followupRun.originatingThreadId != null
            ? String(followupRun.originatingThreadId)
            : undefined,
        idempotencyKey: crypto.randomUUID(),
        deliver: true,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: contextSnapshot,
        label: "parallel-queue",
        spawnedBy: followupRun.run.sessionKey,
      },
      timeoutMs: 10_000,
    });
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(`smart-queue-router: subagent spawn failed: ${msg}`);
    return null;
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

  // Step 1: Classify
  let route: "steer" | "parallel";
  try {
    route = await classifyMessage({
      newMessage: followupRun.prompt,
      sessionFile: followupRun.run.sessionFile,
    });
  } catch {
    // Classification failed — fall back to original behavior
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    return "fallback-enqueued";
  }

  // Step 2: Route
  if (route === "steer") {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    return "steer-enqueued";
  }

  // Step 3: Build context + spawn sub-agent
  const contextSnapshot = await buildParallelContextSnapshot({
    sessionFile: followupRun.run.sessionFile,
  });

  const result = await spawnParallelSubagent({
    followupRun,
    contextSnapshot,
  });

  if (!result) {
    // Spawn failed — fall back to serial queue
    logVerbose("smart-queue-router: spawn failed, falling back to serial queue");
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    return "fallback-enqueued";
  }

  logVerbose(`smart-queue-router: parallel sub-agent spawned (runId=${result.runId})`);
  return "parallel-spawned";
}
