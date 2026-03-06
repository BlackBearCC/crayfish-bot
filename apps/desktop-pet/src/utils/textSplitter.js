/**
 * textSplitter.js
 * 标点感知的文本分句工具
 *
 * 按中英文标点拆分文本，避免在句中硬切。
 * 短片段（<4字符）自动合并到前一段。
 */

const BREAK_RE = /([。．.！!？?，,；;、\n])/g;

/**
 * @param {string} text
 * @returns {{ segments: string[], remainder: string }}
 */
export function splitAtPunctuation(text) {
  const segments = [];
  let lastIdx = 0;
  let m;

  BREAK_RE.lastIndex = 0;
  while ((m = BREAK_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const seg = text.slice(lastIdx, end).trim();
    if (!seg) { lastIdx = end; continue; }

    // 短片段合并到前一段
    if (seg.length < 4 && segments.length > 0) {
      segments[segments.length - 1] += seg;
    } else {
      segments.push(seg);
    }
    lastIdx = end;
  }

  return { segments, remainder: text.slice(lastIdx) };
}
