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
  return path.join(resolveStateDir(env), "logs", "prompt-debug.log");
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  return parseBooleanValue(env.PETCLAW_PROMPT_DEBUG) ?? false;
}

function formatSystemWithSeparators(system: string | undefined): string {
  if (!system) return "[无系统提示词]";
  const lines = system.split('\n');
  return lines.map(line => `  ${line}`).join('\n');
}

function formatMessagesWithSeparators(messages: unknown[]): string {
  if (!messages || messages.length === 0) return "[无消息]";

  const parts: string[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = String(m.role || 'unknown').toUpperCase();
    const content = extractContentText(m.content);
    parts.push(`\n--- [${role}] ---`);
    parts.push(content || '[空内容]');
  }
  return parts.join('\n');
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Handle content blocks (text, image, etc.)
    return content.map(block => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'image_url' && typeof b.image_url === 'string') return `[图片: ${b.image_url}]`;
        if (b.type === 'image_url' && b.image_url && typeof b.image_url === 'object') {
          const url = (b.image_url as Record<string, unknown>).url;
          return `[图片: ${url}]`;
        }
        return `[${b.type}]`;
      }
      return String(block);
    }).join('\n');
  }
  return String(content || '');
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

/**
 * Format entry as human-readable text with clear separators.
 */
function formatReadableEntry(entry: {
  ts: string;
  runId?: string;
  sessionKey?: string;
  provider?: string;
  model?: unknown;
  system?: string;
  messages: unknown[];
}): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push(`║ 时间: ${entry.ts}`);
  lines.push(`║ Run: ${entry.runId || 'N/A'}`);
  lines.push(`║ Session: ${entry.sessionKey || 'N/A'}`);
  lines.push(`║ Provider: ${entry.provider || 'N/A'} | Model: ${String(entry.model || 'N/A')}`);
  lines.push('╠══════════════════════════════════════════════════════════════════╣');
  lines.push('║ SYSTEM PROMPT');
  lines.push('╠══════════════════════════════════════════════════════════════════╣');
  lines.push(formatSystemWithSeparators(entry.system));
  lines.push('╠══════════════════════════════════════════════════════════════════╣');
  lines.push('║ MESSAGES');
  lines.push('╠══════════════════════════════════════════════════════════════════╣');
  lines.push(formatMessagesWithSeparators(entry.messages));
  lines.push('╚══════════════════════════════════════════════════════════════════╝');
  lines.push('');
  return lines.join('\n');
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
          const readable = formatReadableEntry(entry);
          writer.write(readable);
        }
        options?.onPayload?.(payload);
      };
      return streamFn(model, context, { ...options, onPayload: nextOnPayload });
    };
    return wrapped;
  };

  return { wrapStreamFn };
}
