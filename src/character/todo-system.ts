/**
 * Todo System — Daily todo list generated from chat context
 *
 * AI can create todos from conversations, users can view/complete/delete them.
 * Verification is done by AI or user confirmation.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";

// ─── Types ───

export interface TodoItem {
  id: string;
  title: string;
  description: string;
  status: "pending" | "completed" | "verified";
  source: string; // Context where this todo was created
  category: "task" | "reminder" | "follow_up" | "learning";
  createdAt: number;
  completedAt?: number;
  verifiedAt?: number;
  rewards?: {
    exp?: number;
    coins?: number;
  };
}

export interface TodoSystemConfig {
  maxTodos?: number;
  defaultRewards?: {
    exp: number;
    coins: number;
  };
}

const DEFAULT_CONFIG: Required<TodoSystemConfig> = {
  maxTodos: 10,
  defaultRewards: {
    exp: 10,
    coins: 5,
  },
};

// ─── Todo System ───

export class TodoSystem {
  private readonly bus: EventBus;
  private readonly store: PersistenceStore;
  private readonly config: Required<TodoSystemConfig>;
  private todos: Map<string, TodoItem> = new Map();

  constructor(
    bus: EventBus,
    store: PersistenceStore,
    config?: TodoSystemConfig
  ) {
    this.bus = bus;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.load();
  }

  private load(): void {
    const data = this.store.load("todo-system");
    if (data?.todos) {
      const list = data.todos as TodoItem[];
      // Clean up verified todos older than 24 hours
      const now = Date.now();
      const filtered = list.filter(
        (t) => t.status !== "verified" || now - (t.verifiedAt ?? 0) < 24 * 60 * 60 * 1000
      );
      for (const todo of filtered) {
        this.todos.set(todo.id, todo);
      }
    }
  }

  private save(): void {
    this.store.save("todo-system", {
      todos: Array.from(this.todos.values()),
    });
  }

  /**
   * Create a new todo item (AI only)
   */
  createTodo(params: {
    title: string;
    description?: string;
    category?: TodoItem["category"];
    source?: string;
    rewards?: TodoItem["rewards"];
  }): TodoItem {
    const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Enforce max todos limit
    if (this.todos.size >= this.config.maxTodos) {
      // Remove oldest pending todo
      const oldest = Array.from(this.todos.values())
        .filter((t) => t.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        this.todos.delete(oldest.id);
        this.bus.emit("todo:deleted", { todo: oldest });
      }
    }

    const todo: TodoItem = {
      id,
      title: params.title,
      description: params.description ?? "",
      status: "pending",
      source: params.source ?? "chat",
      category: params.category ?? "task",
      createdAt: Date.now(),
      rewards: params.rewards ?? this.config.defaultRewards,
    };

    this.todos.set(id, todo);
    this.save();

    this.bus.emit("todo:created", { todo });

    return todo;
  }

  /**
   * User marks a todo as completed (triggers verification flow)
   */
  completeTodo(todoId: string): { ok: boolean; todo?: TodoItem; reason?: string } {
    const todo = this.todos.get(todoId);
    if (!todo) {
      return { ok: false, reason: "Todo not found" };
    }

    if (todo.status === "verified") {
      return { ok: false, reason: "Todo already verified" };
    }

    todo.status = "completed";
    todo.completedAt = Date.now();
    this.save();

    this.bus.emit("todo:completed", { todo });

    return { ok: true, todo };
  }

  /**
   * AI verifies a completed todo and awards rewards
   */
  verifyTodo(todoId: string): { ok: boolean; todo?: TodoItem; rewards?: TodoItem["rewards"]; reason?: string } {
    const todo = this.todos.get(todoId);
    if (!todo) {
      return { ok: false, reason: "Todo not found" };
    }

    if (todo.status === "pending") {
      return { ok: false, reason: "Todo not yet completed" };
    }

    if (todo.status === "verified") {
      return { ok: false, reason: "Todo already verified" };
    }

    todo.status = "verified";
    todo.verifiedAt = Date.now();
    this.save();

    const rewards = todo.rewards ?? this.config.defaultRewards;

    this.bus.emit("todo:verified", { todo, rewards });

    return { ok: true, todo, rewards };
  }

  /**
   * Delete a todo
   */
  deleteTodo(todoId: string): { ok: boolean; reason?: string } {
    const todo = this.todos.get(todoId);
    if (!todo) {
      return { ok: false, reason: "Todo not found" };
    }

    this.todos.delete(todoId);
    this.save();

    this.bus.emit("todo:deleted", { todo });

    return { ok: true };
  }

  /**
   * Regenerate todos (clear all pending and create new ones)
   */
  regenerateTodos(): { ok: boolean; cleared: number } {
    let cleared = 0;
    for (const [id, todo] of Array.from(this.todos.entries())) {
      if (todo.status === "pending") {
        this.todos.delete(id);
        cleared++;
      }
    }
    this.save();

    this.bus.emit("todo:regenerated", { cleared });

    return { ok: true, cleared };
  }

  /**
   * Get all todos
   */
  getTodos(): TodoItem[] {
    return Array.from(this.todos.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get pending todos
   */
  getPendingTodos(): TodoItem[] {
    return this.getTodos().filter((t) => t.status === "pending");
  }

  /**
   * Get completed todos awaiting verification
   */
  getCompletedTodos(): TodoItem[] {
    return this.getTodos().filter((t) => t.status === "completed");
  }

  /**
   * Get todo by ID
   */
  getTodo(todoId: string): TodoItem | undefined {
    return this.todos.get(todoId);
  }

  /**
   * Get todo stats
   */
  getStats(): {
    total: number;
    pending: number;
    completed: number;
    verified: number;
  } {
    const all = this.getTodos();
    return {
      total: all.length,
      pending: all.filter((t) => t.status === "pending").length,
      completed: all.filter((t) => t.status === "completed").length,
      verified: all.filter((t) => t.status === "verified").length,
    };
  }
}
