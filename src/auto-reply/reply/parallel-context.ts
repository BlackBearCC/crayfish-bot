/**
 * Parallel Context — builds a context snapshot for sub-agents spawned by the
 * smart queue router.  Combines:
 *   1. Character state (mood/hunger/level/intimacy)
 *   2. Top-1 memory cluster summary
 *   3. Last N turns of real chat history from the session JSONL file
 *
 * All reads are read-only — no write lock required.
 */

import fs from "node:fs";
import readline from "node:readline";
import { getCharacterEngine } from "../../gateway/server-methods/character.js";

// ─── Session JSONL reader ───

interface SessionMessageEntry {
  role: "user" | "assistant";
  text: string;
}

/**
 * Read the last `turns` pairs of user/assistant messages from a session JSONL
 * file.  Only real chat messages are collected (type === "message", role ===
 * "user" | "assistant").  The file is streamed line-by-line so we never load
 * the entire transcript into memory.
 */
export async function readRecentSessionMessages(
  sessionFile: string,
  turns = 5,
): Promise<SessionMessageEntry[]> {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return [];
  }

  const collected: SessionMessageEntry[] = [];
  const maxEntries = turns * 2; // user + assistant per turn

  try {
    const stream = fs.createReadStream(sessionFile, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: {
            role?: string;
            content?: Array<{ type?: string; text?: string }> | string;
          };
        };
        if (entry.type !== "message") continue;
        const role = entry.message?.role;
        if (role !== "user" && role !== "assistant") continue;

        // Extract text content
        let text = "";
        const content = entry.message?.content;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!)
            .join("\n");
        }
        if (!text.trim()) continue;

        collected.push({ role: role as "user" | "assistant", text: text.trim() });
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return [];
  }

  // Return only the last N entries
  return collected.slice(-maxEntries);
}

// ─── Context snapshot builder ───

export interface ParallelContextParams {
  sessionFile: string;
  turns?: number;
}

/**
 * Build the full context snapshot string injected as `extraSystemPrompt` into
 * the sub-agent.  Gracefully degrades if any data source is unavailable.
 */
export async function buildParallelContextSnapshot(
  params: ParallelContextParams,
): Promise<string> {
  const { sessionFile, turns = 5 } = params;
  const parts: string[] = [];

  // 1. Character state
  const engine = getCharacterEngine();
  if (engine) {
    const stateCtx = engine.getPromptContext();
    if (stateCtx) {
      parts.push(`## 角色当前状态\n${stateCtx}`);
    }

    // 2. Memory summary (top-1)
    const memorySummary = engine.getMemorySummary(1);
    if (memorySummary) {
      parts.push(`## 记忆摘要\n${memorySummary}`);
    }
  }

  // 3. Recent chat history
  const messages = await readRecentSessionMessages(sessionFile, turns);
  if (messages.length > 0) {
    const chatLines = messages.map(
      (m) => `${m.role === "user" ? "用户" : "助手"}: ${m.text}`,
    );
    parts.push(`## 最近对话记录\n${chatLines.join("\n")}`);
  }

  if (parts.length === 0) {
    return "";
  }

  return `以下是你需要了解的上下文（来自主会话）：\n\n${parts.join("\n\n")}`;
}
