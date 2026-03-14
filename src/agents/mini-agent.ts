/**
 * MiniAgent — 轻量级无状态 Agent 调用
 *
 * 特点：
 * - 无 session 生命周期，一次调用
 * - 可配置轻量工具子集
 * - 不阻塞后续消息（不注册到 embeddedPiRuns）
 * - 支持会话镜像（写回主 session JSONL）
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "../config/config.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import { getLogger } from "../logging/logger.js";
import type { AnyAgentTool } from "./tools/common.js";
import { jsonResult, readStringParam } from "./tools/common.js";

// ─── Types ───

export interface MiniAgentParams {
  /** 可选 system prompt */
  systemPrompt?: string;
  /** 必需 user prompt */
  userPrompt: string;
  /** 可选工具列表 */
  tools?: AnyAgentTool[];
  /** 默认 1024 */
  maxTokens?: number;
  /** 默认 0.7 */
  temperature?: number;
  /** 默认 false */
  stream?: boolean;
  /** streaming 回调 */
  onChunk?: (chunk: string) => void;
  /** 角色状态/记忆等上下文 */
  contextSnapshot?: string;
  /** 会话镜像配置 */
  mirrorToSession?: {
    sessionFile: string;
    sessionKey?: string;
  };
}

export interface MiniAgentResult {
  ok: boolean;
  text?: string;
  error?: string;
  toolCalls?: Array<{ name: string; args: unknown; result: unknown }>;
}

export interface MiniAgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ─── LLM Config Resolution ───

function resolveMiniAgentLLMConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const cfg = loadConfig();
  const agentModel = (cfg as Record<string, unknown> as { agents?: { defaults?: { model?: { primary?: string; auxiliary?: string } } } }).agents?.defaults?.model;
  const providers = cfg.models?.providers;
  if (!providers) return null;

  // Prefer auxiliary model for lightweight agent calls; fallback to primary
  const modelRef = agentModel?.auxiliary || agentModel?.primary;
  if (!modelRef) return null;

  const slashIdx = modelRef.indexOf("/");
  if (slashIdx <= 0) return null;

  const providerKey = modelRef.substring(0, slashIdx);
  const modelName = modelRef.substring(slashIdx + 1);
  const provider = providers[providerKey];
  if (!provider?.baseUrl || !provider?.apiKey) return null;

  return {
    baseUrl: provider.baseUrl,
    apiKey: String(provider.apiKey),
    model: modelName,
  };
}

// ─── Tool Execution ───

async function executeToolCall(
  toolCall: MiniAgentToolCall,
  tools: AnyAgentTool[],
): Promise<{ result: string; toolName: string; args: unknown }> {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      result: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }),
      toolName: toolCall.name,
      args: toolCall.args,
    };
  }

  try {
    const result = await tool.execute(toolCall.id, toolCall.args);
    // result 是 JSON 字符串或 { text: string } 格式
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    return {
      result: resultStr,
      toolName: tool.name,
      args: toolCall.args,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: JSON.stringify({ error: message }),
      toolName: tool.name,
      args: toolCall.args,
    };
  }
}

// ─── Session Mirror ───

function mirrorToSessionFile(
  sessionFile: string,
  userPrompt: string,
  assistantReply: string,
): void {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    // 如果文件不存在，尝试创建目录
    const dir = sessionFile.substring(0, sessionFile.lastIndexOf("/"));
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const ts = Date.now();
  const userEntry = JSON.stringify({
    type: "message",
    ts,
    message: { role: "user", content: userPrompt },
  }) + "\n";

  const assistantEntry = JSON.stringify({
    type: "message",
    ts: ts + 1,
    message: { role: "assistant", content: assistantReply },
  }) + "\n";

  fs.appendFileSync(sessionFile, userEntry + assistantEntry, "utf-8");
}

// ─── Main Entry ───

const MAX_TOOL_ROUNDS = 2;

export async function runMiniAgent(params: MiniAgentParams): Promise<MiniAgentResult> {
  const {
    systemPrompt,
    userPrompt,
    tools = [],
    maxTokens = 1024,
    temperature = 0.7,
    stream = false,
    onChunk,
    contextSnapshot,
    mirrorToSession,
  } = params;

  const log = getLogger();
  const llmCfg = resolveMiniAgentLLMConfig();
  if (!llmCfg) {
    return { ok: false, error: "No LLM config available for MiniAgent" };
  }

  // 生成临时 runId（用于事件关联，但不阻塞后续消息）
  const miniRunId = `mini-agent:${crypto.randomUUID()}`;

  // 注册到 runContextById（用于事件关联）
  if (mirrorToSession?.sessionKey) {
    registerAgentRunContext(miniRunId, {
      sessionKey: mirrorToSession.sessionKey,
    });
  }

  try {
    // 构建消息
    const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: MiniAgentToolCall[]; tool_call_id?: string }> = [];

    // System prompt
    const systemParts: string[] = [];
    if (contextSnapshot) {
      systemParts.push(contextSnapshot);
    }
    if (systemPrompt) {
      systemParts.push(systemPrompt);
    }
    if (systemParts.length > 0) {
      messages.push({ role: "system", content: systemParts.join("\n\n") });
    }

    // User prompt
    messages.push({ role: "user", content: userPrompt });

    const toolCallsLog: Array<{ name: string; args: unknown; result: unknown }> = [];
    let currentText = "";
    let toolRound = 0;

    // 工具调用循环
    while (toolRound <= MAX_TOOL_ROUNDS) {
      // 构建 OpenAI 格式的工具定义
      const toolsDef = tools.length > 0 ? {
        tools: tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
      } : {};

      // 调用 LLM
      const requestBody: Record<string, unknown> = {
        model: llmCfg.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream,
        ...toolsDef,
      };

      log.info({ message: `[mini-agent] LLM call | model=${llmCfg.model} tools=${tools.length} round=${toolRound}` }, "mini-agent");

      const res = await fetch(`${llmCfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmCfg.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown");
        return { ok: false, error: `LLM call failed: ${res.status} ${errText}` };
      }

      if (stream && onChunk) {
        // 流式处理
        const reader = res.body?.getReader();
        if (!reader) {
          return { ok: false, error: "Stream reader not available" };
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data) as {
                  choices?: Array<{
                    delta?: { content?: string; tool_calls?: MiniAgentToolCall[] };
                  }>;
                };
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) {
                  currentText += content;
                  onChunk(content);
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        }
        break; // 流式不处理工具调用
      } else {
        // 非流式处理
        const data = (await res.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{
                id: string;
                function: { name: string; arguments: string };
              }>;
            };
          }>;
        };

        const choice = data.choices?.[0];
        if (!choice?.message) {
          return { ok: false, error: "No message in LLM response" };
        }

        currentText = choice.message.content ?? "";

        // 检查是否有工具调用
        const rawToolCalls = choice.message.tool_calls;
        if (!rawToolCalls || rawToolCalls.length === 0) {
          // 没有工具调用，结束
          break;
        }

        // 有工具调用，但超过了最大轮数
        if (toolRound >= MAX_TOOL_ROUNDS) {
          log.info({ message: `[mini-agent] Max tool rounds reached (${MAX_TOOL_ROUNDS}), stopping` }, "mini-agent");
          break;
        }

        // 解析工具调用
        const toolCalls: MiniAgentToolCall[] = rawToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        }));

        // 将 assistant 消息（含 tool_calls）加入历史
        messages.push({
          role: "assistant",
          content: currentText,
          tool_calls: toolCalls,
        });

        // 执行每个工具调用
        for (const tc of toolCalls) {
          const execResult = await executeToolCall(tc, tools);
          toolCallsLog.push({
            name: execResult.toolName,
            args: execResult.args,
            result: execResult.result,
          });

          // 将工具结果加入消息
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: execResult.result,
          });
        }

        toolRound++;
      }
    }

    // 会话镜像
    if (mirrorToSession && currentText) {
      try {
        mirrorToSessionFile(
          mirrorToSession.sessionFile,
          userPrompt,
          currentText,
        );
        log.info({ message: `[mini-agent] Mirrored to session: ${mirrorToSession.sessionFile}` }, "mini-agent");
      } catch (err) {
        log.info({ message: `[mini-agent] Failed to mirror: ${err instanceof Error ? err.message : String(err)}` }, "mini-agent");
      }
    }

    return {
      ok: true,
      text: currentText,
      toolCalls: toolCallsLog.length > 0 ? toolCallsLog : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    // 清理 runContext
    clearAgentRunContext(miniRunId);
  }
}