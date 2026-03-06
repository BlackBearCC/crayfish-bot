/**
 * LearningSystem.js
 * 学习系统 — 用户主动安排角色学习技能课程
 *
 * 参考 QQ 宠物学习机制：选课 → 消耗饱腹/心情 → 倒计时 → 获得经验+技能碎片
 * 课程按 7 个生活领域分类（来自 DomainSystem），完成后通知 SkillSystem 更新属性。
 *
 * localStorage keys:
 *   learn-courses   → 可用课程列表 (Course[])
 *   learn-progress  → { [domainName]: { xp, level } }
 *   learn-active    → 当前学习会话 | null
 *   learn-history   → 已完成课程记录 (Course[])
 */

const XP_PER_LESSON = 10;
export const LEVEL_THRESHOLDS = [0, 30, 80, 150, 250, 380, 550, 770, 1050, 1400];
const MAX_LEVEL = 10;

const LESSON_DURATION_MIN  = 30 * 60 * 1000;
const LESSON_DURATION_MAX  = 60 * 60 * 1000;

const MIN_HUNGER_TO_START = 30;
const MIN_MOOD_TO_START = 30;

const COURSE_EXPIRE_DAYS = 30;

export class LearningSystem {
  constructor(hungerSystem, moodSystem) {
    this._hungerSystem = hungerSystem;
    this._moodSystem = moodSystem;

    this._courses = this._loadCourses();
    this._progress = this._loadProgress();
    this._active = this._loadActive();
    this._history = this._loadHistory();

    this._onLessonComplete = [];
    this._onCourseComplete = [];
    this._onLessonInterrupt = [];
    this._onLevelUp = [];

    // 清理过期课程
    this._cleanExpired();
  }

  // ===== 课程管理 =====

  getCourses() { return this._courses; }

  getCoursesByCategory(catName) {
    return this._courses.filter(c => c.categoryName === catName);
  }

  addCourse(course) {
    course.id = course.id || `course-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    course.fragments = course.fragments || 0;
    course.totalFragments = course.complexity;
    course.createdAt = course.createdAt || Date.now();
    course.expiresAt = course.expiresAt || (Date.now() + COURSE_EXPIRE_DAYS * 86400000);
    this._courses.push(course);
    this._saveCourses();
    return course;
  }

  removeCourse(courseId) {
    this._courses = this._courses.filter(c => c.id !== courseId);
    this._saveCourses();
  }

  getHistory() { return this._history; }

  // ===== 学习流程 =====

  canStartLearning() {
    if (this._active) return { ok: false, reason: '正在学习中' };
    if (this._hungerSystem.getHunger() < MIN_HUNGER_TO_START)
      return { ok: false, reason: '太饿了，先喂饱再学习吧' };
    if (this._moodSystem.getMood() < MIN_MOOD_TO_START)
      return { ok: false, reason: '心情不好，先安慰一下吧' };
    return { ok: true };
  }

  /**
   * 开始一节课
   * @param {string} courseId
   * @returns {{ ok, reason?, lesson? }}
   */
  startLesson(courseId) {
    const check = this.canStartLearning();
    if (!check.ok) return check;

    const course = this._courses.find(c => c.id === courseId);
    if (!course) return { ok: false, reason: '课程不存在' };

    // 根据复杂度调整时长：低复杂度偏短，高复杂度偏长
    const ratio = (course.complexity - 1) / 4; // 0~1
    const duration = Math.round(LESSON_DURATION_MIN + ratio * (LESSON_DURATION_MAX - LESSON_DURATION_MIN));

    this._active = {
      courseId: course.id,
      categoryName: course.categoryName,
      courseTitle: course.title,
      elapsed: 0,
      duration,
      startedAt: Date.now(),
    };
    this._saveActive();

    // 加速衰减
    this._hungerSystem.setDecayMultiplier(2);
    this._moodSystem.setDecayMultiplier(1.5);

    return { ok: true, lesson: this._active };
  }

  /**
   * 每帧由主循环调用
   * @param {number} deltaMs
   */
  update(deltaMs) {
    if (!this._active) return;

    this._active.elapsed += deltaMs;

    // 检查中断条件
    if (this._hungerSystem.getHunger() <= 0 || this._moodSystem.getMood() <= 15) {
      this._interruptLesson();
      return;
    }

    // 检查完成
    if (this._active.elapsed >= this._active.duration) {
      this._completeLesson();
    }
  }

  abortLesson() {
    if (!this._active) return;
    this._interruptLesson('主动中断');
  }

  isLearning() { return !!this._active; }

  getActiveLesson() {
    if (!this._active) return null;
    return {
      ...this._active,
      remaining: Math.max(0, this._active.duration - this._active.elapsed),
      progress: Math.min(1, this._active.elapsed / this._active.duration),
    };
  }

  // ===== 等级 =====

  getProgress(categoryName) {
    const p = this._progress[categoryName] || { xp: 0, level: 1 };
    const nextXp = LEVEL_THRESHOLDS[p.level] || Infinity;
    return { ...p, nextXp };
  }

  getLevelForXp(xp) {
    for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
      if (xp >= LEVEL_THRESHOLDS[i]) return Math.min(i + 1, MAX_LEVEL);
    }
    return 1;
  }

  // ===== 离线续算 =====

  /**
   * 启动时检查是否有未完成的学习
   * @returns {{ resumed: boolean, completed: boolean, lesson? }}
   */
  checkOfflineLesson() {
    if (!this._active) return { resumed: false, completed: false };

    // 学习必须在线完成，退出即中断，进度清零
    const lesson = this._active;
    this._active = null;
    this._saveActive();
    this._hungerSystem.setDecayMultiplier(1);
    this._moodSystem.setDecayMultiplier(1);

    return { resumed: true, completed: false, interrupted: true, lesson };
  }

  // ===== 回调 =====

  onLessonComplete(cb) { this._onLessonComplete.push(cb); }
  onCourseComplete(cb) { this._onCourseComplete.push(cb); }
  onLessonInterrupt(cb) { this._onLessonInterrupt.push(cb); }
  onLevelUp(cb) { this._onLevelUp.push(cb); }

  // ===== 内部 =====

  _completeLesson() {
    const lesson = this._active;
    if (!lesson) return;

    const catName = lesson.categoryName;

    // 恢复衰减
    this._hungerSystem.setDecayMultiplier(1);
    this._moodSystem.setDecayMultiplier(1);

    // XP 增长（按领域）
    const progress = this._progress[catName] || { xp: 0, level: 1 };
    const oldLevel = progress.level;
    progress.xp += XP_PER_LESSON;
    progress.level = this.getLevelForXp(progress.xp);
    this._progress[catName] = progress;
    this._saveProgress();

    // 碎片判定
    const fragmentChance = 0.30 + progress.level * 0.07;
    const gotFragment = Math.random() < fragmentChance;

    const course = this._courses.find(c => c.id === lesson.courseId);
    if (gotFragment && course) {
      course.fragments = (course.fragments || 0) + 1;
      this._saveCourses();
    }

    // 清除活跃学习
    this._active = null;
    this._saveActive();

    // 触发回调
    const result = {
      courseId: lesson.courseId,
      courseTitle: lesson.courseTitle,
      categoryName: catName,
      xpGained: XP_PER_LESSON,
      level: progress.level,
      gotFragment,
      fragmentProgress: course ? `${course.fragments}/${course.totalFragments}` : '',
    };
    for (const cb of this._onLessonComplete) cb(result);

    // 升级回调
    if (progress.level > oldLevel) {
      for (const cb of this._onLevelUp) cb({ categoryName: catName, level: progress.level });
    }

    // 课程完成判定
    if (course && course.fragments >= course.totalFragments) {
      this._finishCourse(course);
    }
  }

  _interruptLesson(explicitReason) {
    const lesson = this._active;
    if (!lesson) return;

    // 恢复衰减
    this._hungerSystem.setDecayMultiplier(1);
    this._moodSystem.setDecayMultiplier(1);

    this._active = null;
    this._saveActive();

    const reason = explicitReason
      || (this._hungerSystem.getHunger() <= 0 ? '太饿了' : '心情太差了');
    for (const cb of this._onLessonInterrupt) cb({ courseTitle: lesson.courseTitle, reason });
  }

  _finishCourse(course) {
    // 移入历史
    course.completedAt = Date.now();
    this._history.push(course);
    this._saveHistory();

    // 从可用列表移除
    this.removeCourse(course.id);

    for (const cb of this._onCourseComplete) cb(course);
  }

  _cleanExpired() {
    const now = Date.now();
    const before = this._courses.length;
    this._courses = this._courses.filter(c => c.expiresAt > now);
    if (this._courses.length !== before) this._saveCourses();
  }

  // ===== 持久化 =====

  _loadCourses() {
    try { return JSON.parse(localStorage.getItem('learn-courses') || '[]'); }
    catch { return []; }
  }
  _saveCourses() { localStorage.setItem('learn-courses', JSON.stringify(this._courses)); }

  _loadProgress() {
    try { return JSON.parse(localStorage.getItem('learn-progress') || '{}'); }
    catch { return {}; }
  }
  _saveProgress() { localStorage.setItem('learn-progress', JSON.stringify(this._progress)); }

  _loadActive() {
    try { return JSON.parse(localStorage.getItem('learn-active') || 'null'); }
    catch { return null; }
  }
  _saveActive() { localStorage.setItem('learn-active', JSON.stringify(this._active)); }

  _loadHistory() {
    try { return JSON.parse(localStorage.getItem('learn-history') || '[]'); }
    catch { return []; }
  }
  _saveHistory() { localStorage.setItem('learn-history', JSON.stringify(this._history)); }
}
