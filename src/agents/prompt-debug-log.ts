/**
 * Universal prompt debug logger.
 *
 * Enabled by setting PETCLAW_PROMPT_DEBUG=1 (or any truthy value).
 * Writes the fully assembled LLM payload (system prompt + messages) to:
 *   ~/.petclaw/logs/prompt-debug.jsonl
 *
 * Works for all providers (OpenAI-compatible, Anthropic, Ollama, etc.).
 * File is rotated to prompt-debug.jsonl.old when it exceeds 500 KB.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

const log = createSubsystemLogger("agent/prompt-debug");

const MAX_FILE_BYTES = 500 * 1024; // 500 KB before rotation

const writers = new Map<string, QueuedFileWriter>();

function resolveLogPath(env: NodeJS.ProcessEnv): string {
  const override = env.PETCLAW_PROMPT_DEBUG_FILE?.trim();
  if (override) return override;
  return path.join(resolveStateDir(env), "logs", "prompt-debug.jsonl");
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  return parseBooleanValue(env.PETCLAW_PROMPT_DEBUG) ?? false;
}

/**
 * Extract system prompt text from payload.
 * Handles both Anthropic format (top-level `system`) and OpenAI format (messages[0].role === "system").
 */
function extractSystem(payload: Record<string, unknown>): string | undefined {
  // Anthropic: { system: string | [{type:"text", text:"..."}] }
  if (payload.system !== undefined) {
    const s = payload.system;
    if (typeof s === "string") return s;
    if (Array.isArray(s)) {
      return s
        .filter((b: unknown) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
        .map((b: unknown) => (b as Record<string, unknown>).text as string)
        .join("\n");
    }
  }
  // OpenAI: messages[0].role === "system"
  if (Array.isArray(payload.messages)) {
    const first = payload.messages[0] as Record<string, unknown> | undefined;
    if (first?.role === "system") {
      const c = first.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .filter((b: unknown) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
          .map((b: unknown) => (b as Record<string, unknown>).text as string)
          .join("\n");
      }
    }
  }
  return undefined;
}

/**
 * Return messages array, stripping the leading system message for OpenAI format
 * (since we already extract it separately).
 */
function extractMessages(payload: Record<string, unknown>): unknown[] {
  if (!Array.isArray(payload.messages)) return [];
  const msgs = payload.messages as Record<string, unknown>[];
  // If system was embedded as first message, skip it
  if (msgs[0]?.role === "system" && payload.system === undefined) {
    return msgs.slice(1);
  }
  return msgs;
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      const oldPath = filePath + ".old";
      fs.renameSync(filePath, oldPath);
    }
  } catch {
    // file doesn't exist yet — fine
  }
}

export type PromptDebugLogger = {
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

export function createPromptDebugLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
}): PromptDebugLogger | null {
  const env = params.env ?? process.env;
  if (!isEnabled(env)) return null;

  const filePath = resolveLogPath(env);

  // Rotate before getting writer so new session starts cleanly if needed
  rotateIfNeeded(filePath);

  const writer = getQueuedFileWriter(writers, filePath);
  log.info("prompt debug logger enabled", { filePath });

  const wrapStreamFn: PromptDebugLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const nextOnPayload = (payload: unknown) => {
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          const system = extractSystem(p);
          const messages = extractMessages(p);
          const entry = {
            ts: new Date().toISOString(),
            runId: params.runId,
            sessionKey: params.sessionKey,
            provider: params.provider,
            model: params.modelId ?? p.model,
            system,
            messages,
          };
          const line = safeJsonStringify(entry);
          if (line) writer.write(line + "\n");
        }
        options?.onPayload?.(payload);
      };
      return streamFn(model, context, { ...options, onPayload: nextOnPayload });
    };
    return wrapped;
  };

  return { wrapStreamFn };
}
