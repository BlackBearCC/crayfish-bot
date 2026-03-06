/**
 * Pet Engine — LearningSystem
 *
 * Course-based learning with timer, XP, fragments, and level progression.
 * Replaces the renderer-side LearningSystem.js.
 *
 * Learning must complete while engine is running (online-only).
 * Engine exit = lesson interrupted, no XP.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import type { AttributeEngine } from "./attribute-engine.js";

// ─── Constants ───

const XP_PER_LESSON = 10;
export const LEVEL_THRESHOLDS = [0, 30, 80, 150, 250, 380, 550, 770, 1050, 1400];
const MAX_LEVEL = 10;
const LESSON_DURATION_MIN = 30 * 60 * 1000;
const LESSON_DURATION_MAX = 60 * 60 * 1000;
const MIN_HUNGER_TO_START = 30;
const MIN_MOOD_TO_START = 30;
const COURSE_EXPIRE_DAYS = 30;

// ─── Types ───

export interface Course {
  id: string;
  title: string;
  categoryName: string;
  complexity: number;
  fragments: number;
  totalFragments: number;
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
}

export interface ActiveLesson {
  courseId: string;
  categoryName: string;
  courseTitle: string;
  elapsed: number;
  duration: number;
  startedAt: number;
}

export interface LessonProgress {
  xp: number;
  level: number;
}

export interface LessonResult {
  courseId: string;
  courseTitle: string;
  categoryName: string;
  xpGained: number;
  level: number;
  gotFragment: boolean;
  fragmentProgress: string;
}

interface LearningPersistence {
  courses: Course[];
  progress: Record<string, LessonProgress>;
  active: ActiveLesson | null;
  history: Course[];
}

// ─── LearningSystem ───

export class LearningSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _attributes: AttributeEngine;

  private _courses: Course[] = [];
  private _progress: Record<string, LessonProgress> = {};
  private _active: ActiveLesson | null = null;
  private _history: Course[] = [];

  constructor(bus: EventBus, store: PersistenceStore, attributes: AttributeEngine) {
    this._bus = bus;
    this._store = store;
    this._attributes = attributes;
    this._load();
    this._cleanExpired();

    // If there was an active lesson from a previous session, it's interrupted
    if (this._active) {
      this._active = null;
      this._save();
    }
  }

  // ─── Course Management ───

  getCourses(): Course[] {
    return [...this._courses];
  }

  getCoursesByCategory(catName: string): Course[] {
    return this._courses.filter((c) => c.categoryName === catName);
  }

  addCourse(course: Partial<Course> & { title: string; categoryName: string; complexity: number }): Course {
    const full: Course = {
      id: course.id ?? `course-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: course.title,
      categoryName: course.categoryName,
      complexity: course.complexity,
      fragments: course.fragments ?? 0,
      totalFragments: course.complexity,
      createdAt: course.createdAt ?? Date.now(),
      expiresAt: course.expiresAt ?? Date.now() + COURSE_EXPIRE_DAYS * 86400000,
    };
    this._courses.push(full);
    this._save();
    return full;
  }

  removeCourse(courseId: string): void {
    this._courses = this._courses.filter((c) => c.id !== courseId);
    this._save();
  }

  getHistory(): Course[] {
    return [...this._history];
  }

  // ─── Learning Flow ───

  canStartLearning(): { ok: boolean; reason?: string } {
    if (this._active) return { ok: false, reason: "正在学习中" };
    const hunger = this._attributes.getValue("hunger");
    if (hunger < MIN_HUNGER_TO_START) return { ok: false, reason: "太饿了，先喂饱再学习吧" };
    const mood = this._attributes.getValue("mood");
    if (mood < MIN_MOOD_TO_START) return { ok: false, reason: "心情不好，先安慰一下吧" };
    return { ok: true };
  }

  startLesson(courseId: string): { ok: boolean; reason?: string; lesson?: ActiveLesson } {
    const check = this.canStartLearning();
    if (!check.ok) return check;

    const course = this._courses.find((c) => c.id === courseId);
    if (!course) return { ok: false, reason: "课程不存在" };

    const ratio = (course.complexity - 1) / 4;
    const duration = Math.round(LESSON_DURATION_MIN + ratio * (LESSON_DURATION_MAX - LESSON_DURATION_MIN));

    this._active = {
      courseId: course.id,
      categoryName: course.categoryName,
      courseTitle: course.title,
      elapsed: 0,
      duration,
      startedAt: Date.now(),
    };
    this._save();
    return { ok: true, lesson: this._active };
  }

  /** Called by engine tick */
  tick(deltaMs: number): void {
    if (!this._active) return;

    this._active.elapsed += deltaMs;

    // Interrupt if starving or mood bottomed out
    const hunger = this._attributes.getValue("hunger");
    const mood = this._attributes.getValue("mood");
    if (hunger <= 0 || mood <= 15) {
      this._interruptLesson(hunger <= 0 ? "太饿了" : "心情太差了");
      return;
    }

    // Check completion
    if (this._active.elapsed >= this._active.duration) {
      this._completeLesson();
    }
  }

  abortLesson(): void {
    if (!this._active) return;
    this._interruptLesson("主动中断");
  }

  isLearning(): boolean {
    return this._active !== null;
  }

  getActiveLesson(): (ActiveLesson & { remaining: number; progress: number }) | null {
    if (!this._active) return null;
    return {
      ...this._active,
      remaining: Math.max(0, this._active.duration - this._active.elapsed),
      progress: Math.min(1, this._active.elapsed / this._active.duration),
    };
  }

  // ─── Level Queries ───

  getProgress(categoryName: string): LessonProgress & { nextXp: number } {
    const p = this._progress[categoryName] ?? { xp: 0, level: 1 };
    const nextXp = LEVEL_THRESHOLDS[p.level] ?? Infinity;
    return { ...p, nextXp };
  }

  getLevelForXp(xp: number): number {
    for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
      if (xp >= LEVEL_THRESHOLDS[i]!) return Math.min(i + 1, MAX_LEVEL);
    }
    return 1;
  }

  // ─── Internal ───

  private _completeLesson(): void {
    const lesson = this._active;
    if (!lesson) return;

    const catName = lesson.categoryName;
    const progress = this._progress[catName] ?? { xp: 0, level: 1 };
    const oldLevel = progress.level;
    progress.xp += XP_PER_LESSON;
    progress.level = this.getLevelForXp(progress.xp);
    this._progress[catName] = progress;

    // Fragment chance
    const fragmentChance = 0.3 + progress.level * 0.07;
    const gotFragment = Math.random() < fragmentChance;
    const course = this._courses.find((c) => c.id === lesson.courseId);
    if (gotFragment && course) {
      course.fragments = (course.fragments ?? 0) + 1;
    }

    this._active = null;
    this._save();

    // Check course completion
    if (course && course.fragments >= course.totalFragments) {
      course.completedAt = Date.now();
      this._history.push(course);
      this._courses = this._courses.filter((c) => c.id !== course.id);
      this._save();
    }
  }

  private _interruptLesson(_reason: string): void {
    this._active = null;
    this._save();
  }

  private _cleanExpired(): void {
    const now = Date.now();
    const before = this._courses.length;
    this._courses = this._courses.filter((c) => c.expiresAt > now);
    if (this._courses.length !== before) this._save();
  }

  // ─── Persistence ───

  private _load(): void {
    const saved = this._store.load("learning-system");
    if (!saved) return;
    try {
      const data = saved as unknown as LearningPersistence;
      if (data.courses) this._courses = data.courses;
      if (data.progress) this._progress = data.progress;
      if (data.active) this._active = data.active;
      if (data.history) this._history = data.history;
    } catch {
      // ignore
    }
  }

  private _save(): void {
    const data: LearningPersistence = {
      courses: this._courses,
      progress: this._progress,
      active: this._active,
      history: this._history,
    };
    this._store.save("learning-system", {
      ...data,
      updatedAt: Date.now(),
    });
  }
}
