/**
 * PetAI.js
 * 宠物层 AI 服务 — 宠物自身的"内心活动"通道
 *
 * 不经过 OpenClaw gateway，由 main 进程直接调用 LLM API。
 * 用于领悟生成、反思等宠物私有的 AI 调用，结果不进聊天面板。
 *
 * 所有 prompt 通过 _buildPrompt(persona, context, task) 统一构建：
 *   [人设] + [情景上下文] + [输出任务约束]
 * persona 从用户配置 systemPrompt 懒加载，支持自定义角色。
 */

const DEFAULT_PERSONA = '你是一只可爱的桌面宠物猫';

export class PetAI {
  constructor(electronAPI) {
    this.electronAPI = electronAPI;
    this._busy = false;
    this._persona = null;
  }

  get isBusy() { return this._busy; }

  /** 获取用户配置的人设，缓存结果 */
  async _getPersona() {
    if (this._persona) return this._persona;
    try {
      const cfg = await this.electronAPI.getConfig?.();
      this._persona = cfg?.systemPrompt?.trim() || DEFAULT_PERSONA;
    } catch {
      this._persona = DEFAULT_PERSONA;
    }
    return this._persona;
  }

  /** 配置变更时重置缓存 */
  resetPersona() { this._persona = null; }

  /**
   * 统一 prompt 构建器
   * @param {string} persona  — 人设描述
   * @param {string} context  — 当前情景（学习/领悟等）
   * @param {string} task     — 输出格式与约束
   */
  _buildPrompt(persona, context, task) {
    return `[角色]\n${persona}\n\n[情景]\n${context}\n\n[任务]\n${task}`;
  }

  // ─── 学习事件反应 ───

  /**
   * 生成学习事件的宠物反应气泡
   * @param {'start'|'complete'|'interrupt'} event
   * @param {string} courseTitle
   * @param {string} categoryName
   * @returns {Promise<string|null>} 气泡文本
   */
  async generateLearningReaction(event, courseTitle, categoryName) {
    if (this._busy) return null;
    this._busy = true;
    try {
      const persona = await this._getPersona();
      const eventDesc = {
        start:     `刚刚开始学习「${courseTitle}」（${categoryName}领域），心情有点紧张又期待`,
        complete:  `刚刚完成了一节「${courseTitle}」的学习（${categoryName}领域），感觉学到了东西`,
        interrupt: `学习「${courseTitle}」被迫中断了，有点遗憾`,
      }[event] || '';

      const prompt = this._buildPrompt(persona, eventDesc,
        '用完全符合角色人设的口吻，说一句表达此刻心情的话。\n约束：10字以内，自然口语，末尾可加一个emoji，不要引号，直接输出文字。');

      const text = await this.electronAPI.petAIComplete(prompt);
      return text?.trim().slice(0, 30) || null;
    } catch (e) {
      console.warn('[PetAI] generateLearningReaction failed:', e.message);
      return null;
    } finally {
      this._busy = false;
    }
  }

  // ─── 学习中碎碎念 ───

  async generateMurmur(courseTitle, categoryName, elapsed, duration) {
    if (this._busy) return null;
    this._busy = true;
    try {
      const persona = await this._getPersona();
      const pct = Math.round((elapsed / duration) * 100);
      const phase = pct < 30 ? '刚开始' : pct < 70 ? '学到一半' : '快学完了';

      const prompt = this._buildPrompt(persona,
        `正在学习「${courseTitle}」（${categoryName}领域），${phase}，进度${pct}%。`,
        '用角色人设的口吻嘟囔一句学习中的小感想。\n约束：8字以内，自然口语，可加一个emoji，不要引号，直接输出。');

      const text = await this.electronAPI.petAIComplete(prompt);
      return text?.trim().slice(0, 20) || null;
    } catch (e) {
      console.warn('[PetAI] generateMurmur failed:', e.message);
      return null;
    } finally {
      this._busy = false;
    }
  }

  // ─── 学习互动问答 ───

  async generateQuizQuestion(courseTitle, categoryName, elapsed, duration) {
    if (this._busy) return null;
    this._busy = true;
    try {
      const persona = await this._getPersona();
      const pct = Math.round((elapsed / duration) * 100);

      const prompt = this._buildPrompt(persona,
        `正在学习「${courseTitle}」（${categoryName}领域），进度${pct}%。`,
        `生成一个关于学习状态的简单互动问题，问主人此刻的感受或状态（不要问具体课程内容）。
问题和回应都要符合角色人设的口吻。

返回严格JSON（无代码块标记，无其他文字）：
{"question":"问题文字，12字以内","choices":[{"text":"选项1，4字以内","mood":10,"intimacy":3},{"text":"选项2","mood":5,"intimacy":2},{"text":"选项3","mood":-5,"intimacy":2}],"reactions":{"0":"选项1时角色的回应，8字内","1":"选项2的回应","2":"选项3的回应"}}`);

      const text = await this.electronAPI.petAIComplete(prompt);
      if (!text) return null;
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    } catch (e) {
      console.warn('[PetAI] generateQuizQuestion failed:', e.message);
      return null;
    } finally {
      this._busy = false;
    }
  }

  // ─── 学习小故事/冷知识 ───

  async generateFunFact(courseTitle, categoryName) {
    if (this._busy) return null;
    this._busy = true;
    try {
      const persona = await this._getPersona();

      const prompt = this._buildPrompt(persona,
        `正在学习「${courseTitle}」（${categoryName}领域），想和主人分享一些有趣的东西。`,
        `分享一个与「${categoryName}」领域相关的有趣冷知识或小故事，用角色人设的口吻讲述。
约束：100-200字，可用markdown格式（加粗、列表等），轻松有趣，末尾加一句角色风格的总结。不要引号包裹，直接输出。`);

      const text = await this.electronAPI.petAIComplete(prompt);
      return text?.trim() || null;
    } catch (e) {
      console.warn('[PetAI] generateFunFact failed:', e.message);
      return null;
    } finally {
      this._busy = false;
    }
  }

  // ─── 领悟生成 ───

  /**
   * @param {string} domainName  知识域名称
   * @param {string[]} recentTopics  最近对话关键词样本
   * @returns {Promise<{bubble,skillName,skillTitle,skillDesc,skillContent,summary}|null>}
   */
  async generateEpiphany(domainName, recentTopics = []) {
    if (this._busy) return null;
    this._busy = true;
    try {
      const persona = await this._getPersona();
      const topicHint = recentTopics.length
        ? `最近涉及的关键词：${recentTopics.slice(0, 8).join('、')}。`
        : '';

      const prompt = this._buildPrompt(persona,
        `你的内心意识。最近陪伴主人经历了许多关于「${domainName}」的事情。${topicHint}`,
        `根据这些经历，生成一次真实的"领悟"事件。bubble 字段要符合角色人设口吻。

返回严格JSON（无代码块标记，无其他文字）：
{"bubble":"一句符合角色口吻的感悟，15字以内，自然口语，不含引号","skillName":"技能英文ID，kebab-case，如code-intuition","skillTitle":"技能中文名，4到8字","skillDesc":"触发描述，给AI agent看，说明何时用此技能，20到30字","skillContent":"技能内容，对AI agent的具体指导，100到200字","summary":"事件摘要，用于记忆系统，20字内"}`);

      const text = await this.electronAPI.petAIComplete(prompt);
      if (!text) return null;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.warn('[PetAI] No JSON in response:', text.slice(0, 100)); return null; }
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[PetAI] generateEpiphany failed:', e.message);
      return null;
    } finally {
      this._busy = false;
    }
  }
}
