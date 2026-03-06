/**
 * LearningEventScheduler.js
 * 学习期间互动事件调度器 — 碎碎念 / 互动问答 / 小故事
 *
 * 在 LearningSystem 活跃期间运行，按随机间隔触发三类事件。
 * 事件完成后自动恢复 work 动画。
 */

const MIN_INTERVAL = 2 * 60 * 1000;   // 2 分钟
const MAX_INTERVAL = 3 * 60 * 1000;   // 3 分钟
const FIRST_MIN    = 30 * 1000;        // 首次 30s
const FIRST_MAX    = 60 * 1000;        // 首次 60s

// 加权随机：murmur 50%, quiz 30%, story 20%
const WEIGHTS = { murmur: 50, quiz: 30, story: 20 };

export class LearningEventScheduler {
  /**
   * @param {object} deps
   * @param {import('./PetAI').PetAI} deps.petAI
   * @param {import('../ui/Bubble').Bubble} deps.bubble
   * @param {import('../ui/MarkdownPanel').MarkdownPanel} deps.markdownPanel
   * @param {import('./StateMachine').StateMachine} deps.stateMachine
   * @param {import('./MoodSystem').MoodSystem} deps.moodSystem
   * @param {import('./IntimacySystem').IntimacySystem} deps.intimacySystem
   * @param {object} deps.electronAPI
   * @param {import('../ui/LearningChoiceUI').LearningChoiceUI} deps.choiceUI
   */
  constructor({ petAI, bubble, markdownPanel, stateMachine, moodSystem, intimacySystem, electronAPI, choiceUI }) {
    this._petAI = petAI;
    this._bubble = bubble;
    this._mdPanel = markdownPanel;
    this._sm = stateMachine;
    this._mood = moodSystem;
    this._intimacy = intimacySystem;
    this._api = electronAPI;
    this._choiceUI = choiceUI;

    this._timer = null;
    this._active = false;
    this._lesson = null;
    this._isFirst = true;
  }

  /**
   * 启动调度
   * @param {{ courseTitle: string, categoryName: string, duration: number, getElapsed: () => number }} lesson
   */
  start(lesson) {
    this.stop();
    this._lesson = lesson;
    this._active = true;
    this._isFirst = true;
    this._scheduleNext();
  }

  stop() {
    this._active = false;
    this._lesson = null;
    clearTimeout(this._timer);
    this._timer = null;
    this._choiceUI?.hide();
  }

  // ─── 内部 ───

  _scheduleNext() {
    if (!this._active) return;
    const min = this._isFirst ? FIRST_MIN : MIN_INTERVAL;
    const max = this._isFirst ? FIRST_MAX : MAX_INTERVAL;
    const delay = min + Math.random() * (max - min);
    this._timer = setTimeout(() => this._fire(), delay);
  }

  async _fire() {
    if (!this._active) return;

    // PetAI 忙或气泡正在显示 → 延迟 10s 重试
    if (this._petAI?.isBusy || this._bubble?.isVisible()) {
      this._timer = setTimeout(() => this._fire(), 10000);
      return;
    }

    const type = this._isFirst ? 'murmur' : this._selectType();
    this._isFirst = false;

    try {
      switch (type) {
        case 'murmur': await this._doMurmur(); break;
        case 'quiz':   await this._doQuiz();   break;
        case 'story':  await this._doStory();  break;
      }
    } catch (e) {
      console.warn('[LearningEventScheduler]', type, 'failed:', e.message);
    }

    this._scheduleNext();
  }

  _selectType() {
    const roll = Math.random() * 100;
    if (roll < WEIGHTS.murmur) return 'murmur';
    if (roll < WEIGHTS.murmur + WEIGHTS.quiz) return 'quiz';
    return 'story';
  }

  // ─── A: 碎碎念 ───

  async _doMurmur() {
    const { courseTitle, categoryName, duration, getElapsed } = this._lesson;
    const text = await this._petAI.generateMurmur(courseTitle, categoryName, getElapsed(), duration);
    if (!text || !this._active) return;

    this._sm.transition('talk', { force: true, duration: 2000 });
    this._bubble.show(text, 4000);
    setTimeout(() => this._restoreWork(), 2200);

    this._log(`[pet:murmur] ${text}`);
  }

  // ─── B: 互动问答 ───

  async _doQuiz() {
    const { courseTitle, categoryName, duration, getElapsed } = this._lesson;
    const data = await this._petAI.generateQuizQuestion(courseTitle, categoryName, getElapsed(), duration);
    if (!data?.question || !data?.choices?.length || !this._active) return;

    this._sm.transition('talk', { force: true, duration: 3000 });
    this._bubble.show(data.question, 0); // 不自动隐藏

    this._choiceUI.show(data.question, data.choices, (idx) => {
      if (!this._active) return;
      const choice = data.choices[idx] || {};
      const reaction = data.reactions?.[String(idx)] || '喵~';

      // 奖励
      if (choice.mood)     this._mood.gain(Math.abs(choice.mood));
      if (choice.intimacy) this._intimacy.gain(choice.intimacy);

      // 反应
      this._bubble.hide();
      const anim = (choice.mood || 0) >= 0 ? 'happy' : 'talk';
      this._sm.transition(anim, { force: true, duration: 2000 });
      this._bubble.show(reaction, 3000);
      setTimeout(() => this._restoreWork(), 2200);

      this._log(`[pet:quiz] Q:${data.question} A:${choice.text} mood+${choice.mood} intimacy+${choice.intimacy}`);
    }, 15000);
  }

  // ─── C: 小故事/冷知识 ───

  async _doStory() {
    const { courseTitle, categoryName } = this._lesson;
    const text = await this._petAI.generateFunFact(courseTitle, categoryName);
    if (!text || !this._active) return;

    this._sm.transition('talk', { force: true, duration: 3000 });
    this._bubble.show('给你讲个有趣的~', 2000);

    setTimeout(() => {
      if (!this._active) return;
      this._mdPanel?.show(text, 20000);
      this._restoreWork();
    }, 2200);

    this._log(`[pet:fun-fact] ${text.slice(0, 60)}...`);
  }

  // ─── 工具 ───

  _restoreWork() {
    if (!this._active) return;
    if (this._sm.getState?.() !== 'work' && this._sm.currentState !== 'work') {
      this._sm.transition('work', { force: true });
    }
  }

  _log(text) {
    Promise.all([
      this._api?.appendAgentSession?.(text),
      this._api?.appendAgentMemory?.(text),
    ]).catch(() => {});
  }

  destroy() {
    this.stop();
  }
}
