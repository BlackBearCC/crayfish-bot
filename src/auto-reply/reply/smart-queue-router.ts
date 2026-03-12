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
import { registerSubagentRun } from "../../agents/subagent-registry.js";
import { callGateway } from "../../gateway/call.js";
import { classifierLLMComplete } from "../../gateway/server-methods/character.js";
import { logVerbose } from "../../globals.js";
import { getLogger } from "../../logging/logger.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
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

  const prompt = `你是消息路由分类器，判断新消息应"等待当前任务完成后处理"还是"立即独立处理"。

当前上下文（最近一轮对话）：
用户: ${lastUser}
助手: ${lastAssistant}（当前仍在处理中...）

用户新消息: ${newMessage}

判断规则：
- steer：仅当助手正在执行具体任务（写代码、修改文件、分析数据、搜索等），且新消息是对该任务的直接补充/修正/催促/追问
- parallel：其他所有情况，包括日常聊天、问候、闲聊、新话题、角色扮演对话、无明确执行中任务时的任何消息

只返回 JSON，不要解释。示例：{"route":"parallel"}`;

  const log = getLogger();
  log.info(
    {
      message: `[smart-router] classify prompt snapshot | newMessage="${newMessage.slice(0, 100)}" lastAssistant="${lastAssistant.slice(0, 150)}"`,
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

// ─── Sub-agent spawn ───

async function spawnParallelSubagent(params: {
  followupRun: FollowupRun;
  contextSnapshot: string;
}): Promise<{ runId: string; childSessionKey: string } | null> {
  const { followupRun, contextSnapshot } = params;

  const parentSessionKey = followupRun.run.sessionKey ?? "";
  const agentId = resolveAgentIdFromSessionKey(parentSessionKey) ?? "main";
  const childSessionKey = `agent:${agentId}:subagent:${crypto.randomUUID()}`;
  const idempotencyKey = followupRun.run.clientRunId ?? crypto.randomUUID();

  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: followupRun.prompt,
        sessionKey: childSessionKey,
        channel: followupRun.originatingChannel || "webchat",
        to: followupRun.originatingTo,
        accountId: followupRun.originatingAccountId,
        threadId:
          followupRun.originatingThreadId != null
            ? String(followupRun.originatingThreadId)
            : undefined,
        idempotencyKey,
        deliver: true,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: contextSnapshot,
        label: "parallel-queue",
        spawnedBy: parentSessionKey,
      },
      timeoutMs: 10_000,
    });
    if (!response?.runId) return null;

    try {
      registerSubagentRun({
        runId: response.runId,
        childSessionKey,
        requesterSessionKey: parentSessionKey,
        requesterDisplayKey: parentSessionKey,
        task: followupRun.prompt,
        cleanup: "delete",
        label: "parallel-queue",
      });
    } catch (regErr) {
      const msg = regErr instanceof Error ? regErr.message : String(regErr);
      logVerbose(`smart-queue-router: registerSubagentRun failed (non-fatal): ${msg}`);
    }

    return { runId: response.runId, childSessionKey };
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

  // Non-smart modes: skip classifier, always use serial queue
  if (resolvedQueue.mode !== "smart") {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    return "steer-enqueued";
  }

  // Step 1: Classify (default to steer when uncertain — safe serial queue fallback)
  let route: "steer" | "parallel";
  try {
    route = await classifyMessage({
      newMessage: followupRun.prompt,
      sessionFile: followupRun.run.sessionFile,
    });
  } catch {
    // Classification failed — default to steer (serial queue)
    route = "steer";
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

  const log = getLogger();
  log.info({ message: `[smart-router] parallel sub-agent spawned (runId=${result.runId} childSessionKey=${result.childSessionKey})` }, "smart-router");
  logVerbose(`smart-queue-router: parallel sub-agent spawned (runId=${result.runId} childSessionKey=${result.childSessionKey})`);
  return "parallel-spawned";
}
