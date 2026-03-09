/**
 * Character Engine — DomainSystem
 *
 * Static definitions for life domains, character attributes, and the
 * domain→attribute weight matrix. Also includes keyword-based
 * domain inference from text.
 *
 * Based on:
 *   - Gardner's Multiple Intelligences
 *   - Sternberg's Triarchic Theory
 *   - Goleman's Emotional Intelligence
 */

// ─── 7 Life Domains ───

export interface DomainDef {
  name: string;
  icon: string;
  desc: string;
}

export const DOMAINS: DomainDef[] = [
  { name: "技术", icon: "⚙️", desc: "写代码、调系统、解 Bug" },
  { name: "创作", icon: "🎨", desc: "设计、绘画、艺术创作" },
  { name: "办公", icon: "📋", desc: "写报告、邮件、文档、PPT" },
  { name: "探索", icon: "🔭", desc: "查资料、看新闻、学新东西" },
  { name: "生活", icon: "🌱", desc: "做饭、运动、日常事务" },
  { name: "社交", icon: "💬", desc: "聊天、八卦、人际互动" },
  { name: "情感", icon: "💙", desc: "心情、压力、内心感受" },
];

// ─── 5 Character Skill Attributes ───

export interface SkillAttributeDef {
  key: string;
  name: string;
  icon: string;
  desc: string;
}

export const SKILL_ATTRIBUTES: SkillAttributeDef[] = [
  { key: "logic", name: "逻辑力", icon: "🧠", desc: "分析与推理能力" },
  { key: "creativity", name: "创造力", icon: "✨", desc: "发散思维与想象力" },
  { key: "execution", name: "执行力", icon: "⚡", desc: "专注与实践能力" },
  { key: "empathy", name: "共情力", icon: "🤝", desc: "理解他人的能力" },
  { key: "sensitivity", name: "感受力", icon: "💎", desc: "内省与情感感知" },
];

// ─── Domain → Attribute Weight Matrix ───

export const DOMAIN_ATTR_WEIGHTS: Record<string, Record<string, number>> = {
  "技术": { logic: 3, creativity: 0, execution: 2, empathy: 0, sensitivity: 0 },
  "创作": { logic: 0, creativity: 3, execution: 0, empathy: 0, sensitivity: 2 },
  "办公": { logic: 1, creativity: 0, execution: 3, empathy: 0, sensitivity: 0 },
  "探索": { logic: 2, creativity: 2, execution: 0, empathy: 0, sensitivity: 1 },
  "生活": { logic: 0, creativity: 0, execution: 0, empathy: 2, sensitivity: 3 },
  "社交": { logic: 0, creativity: 0, execution: 0, empathy: 3, sensitivity: 2 },
  "情感": { logic: 0, creativity: 1, execution: 0, empathy: 2, sensitivity: 3 },
};

// ─── Domain Inference ───

interface DomainPattern {
  name: string;
  keywords: string[];
}

const DOMAIN_PATTERNS: DomainPattern[] = [
  { name: "技术", keywords: ["代码", "code", "编程", "调试", "debug", "bug", "函数", "function", "api", "接口", "系统", "报错", "运行", "部署", "框架", "数据库", "sql", "git"] },
  { name: "创作", keywords: ["设计", "design", "画", "插画", "排版", "字体", "配色", "海报", "艺术", "创作", "风格", "视觉", "美术", "图标", "动画"] },
  { name: "办公", keywords: ["报告", "文档", "ppt", "邮件", "email", "会议", "方案", "需求", "产品文档", "提案", "总结", "周报", "计划", "任务"] },
  { name: "探索", keywords: ["搜索", "查资料", "了解", "新闻", "发现", "研究", "资料", "学习", "知识", "教程", "文章", "看到", "最新"] },
  { name: "生活", keywords: ["吃", "做饭", "饭", "菜", "运动", "睡", "健康", "身体", "锻炼", "购物", "家", "出门", "天气", "散步"] },
  { name: "社交", keywords: ["朋友", "聊天", "八卦", "同事", "关系", "聚会", "约", "他说", "她说", "群里", "朋友圈", "分享", "社交"] },
  { name: "情感", keywords: ["感觉", "心情", "难过", "开心", "焦虑", "压力", "累", "烦", "害怕", "担心", "喜欢", "讨厌", "情绪", "想", "希望", "失望"] },
];

const VALID_DOMAIN_NAMES = new Set(DOMAINS.map((d) => d.name));

export function isValidDomain(name: string): boolean {
  return VALID_DOMAIN_NAMES.has(name);
}

/** Infer the most likely domain from text using keyword matching. Returns null if no match. */
export function inferDomainFromText(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  const t = text.toLowerCase();

  let best: string | null = null;
  let bestScore = 0;
  for (const p of DOMAIN_PATTERNS) {
    const score = p.keywords.filter((k) => t.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      best = p.name;
    }
  }
  return bestScore > 0 ? best : null;
}
