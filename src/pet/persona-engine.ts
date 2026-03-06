/**
 * Pet Engine — PersonaEngine
 *
 * Manages character persona for LLM prompt construction.
 * Replaces PetAI's persona caching with a centralized engine.
 *
 * Supports:
 *   - Base persona from config
 *   - Dynamic persona modifiers based on current state (mood, growth stage, etc.)
 *   - Structured prompt building: [Role] + [Context] + [Task]
 */

export interface PersonaModifier {
  /** Human-readable label for debugging */
  label: string;
  /**
   * Given the base persona, return a modified version or extra context.
   * Return null to skip this modifier.
   */
  apply: (base: string) => string | null;
}

export class PersonaEngine {
  private _base: string;
  private _modifiers: PersonaModifier[] = [];

  constructor(basePersona: string) {
    this._base = basePersona;
  }

  /** Update the base persona (e.g. when user changes settings) */
  setBase(persona: string): void {
    this._base = persona;
  }

  get base(): string {
    return this._base;
  }

  /** Register a dynamic modifier (e.g. mood-based tone shift) */
  addModifier(modifier: PersonaModifier): void {
    this._modifiers.push(modifier);
  }

  /** Remove a modifier by label */
  removeModifier(label: string): void {
    this._modifiers = this._modifiers.filter((m) => m.label !== label);
  }

  /** Get the resolved persona with all active modifiers applied */
  resolve(): string {
    let result = this._base;
    for (const mod of this._modifiers) {
      const modified = mod.apply(result);
      if (modified) result = modified;
    }
    return result;
  }

  /**
   * Build a structured prompt in the standard 3-section format.
   *
   * @param context  Situational context (what's happening now)
   * @param task     Output constraints (format, length, style)
   */
  buildPrompt(context: string, task: string): string {
    const persona = this.resolve();
    return `[角色]\n${persona}\n\n[情景]\n${context}\n\n[任务]\n${task}`;
  }
}
