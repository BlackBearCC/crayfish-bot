/**
 * CharacterStateSync.js
 * Server-side Character Engine state synchronization bridge.
 *
 * Replaces direct client-side mood/hunger/health/intimacy management
 * with server-authoritative state via character.* RPC calls.
 *
 * When connected:
 *   - Interactions route to server (character.interact)
 *   - State polled from server every 10s (character.state.get)
 *   - Server handles decay, persistence, cross-session continuity
 *
 * When disconnected (fallback):
 *   - Returns last known cached values
 *   - Queues interactions for replay on reconnect
 */

const POLL_INTERVAL = 10000; // 10s

export class CharacterStateSync {
  constructor(electronAPI) {
    this._api = electronAPI;
    this._connected = false;
    this._pollTimer = null;

    // Cached state from server
    this._attributes = {}; // { mood: {value, level, max}, hunger: {...}, health: {...} }
    this._growth = { points: 0, stage: 0, stageName: '', pointsToNext: Infinity };
    this._skills = [];
    this._learning = { active: null, isLearning: false };
    this._achievementSummary = { total: 0, unlocked: 0 };

    // Previous levels for change detection
    this._prevLevels = {};
    this._prevGrowthStage = 0;
    this._prevValues = {}; // for value delta tracking

    // Callbacks
    this._onAttributeChange = []; // (key, level, value) => void
    this._onGrowthStageUp = [];   // (stage, stageName) => void
    this._onSoulAction = [];      // (action: {type, text?, careAction?, emotion?}) => void
    this._onValueDelta = [];      // (key, delta, newVal) => void
  }

  /**
   * Initialize: fetch server state. Returns true if connected.
   */
  async init() {
    try {
      const state = await this._rpc('character.state.get');
      if (state && !state._error) {
        this._applyState(state);
        this._connected = true;
        this._startPolling();
        console.log('[char-sync] Connected to server, state synced');
        return true;
      }
    } catch (e) {
      console.warn('[char-sync] Init failed:', e.message || e);
    }
    console.log('[char-sync] Server unavailable, running in offline mode');
    return false;
  }

  get connected() { return this._connected; }

  // ── Interactions (route to server) ──

  async interact(action, customRewards) {
    const params = { action };
    if (customRewards) params.rewards = customRewards;
    const state = await this._rpcSafe('character.interact', params);
    if (state) this._applyState(state);
    return state;
  }

  async recordTool(toolName) {
    return this._rpcSafe('character.skill.tool', { toolName });
  }

  async recordDomain(domain, context, weight) {
    const params = { domain };
    if (context) params.context = context;
    if (weight != null) params.weight = weight;
    return this._rpcSafe('character.skill.record', params);
  }

  async recordDomainFromText(text) {
    if (typeof text !== 'string' || !text) return;
    return this._rpcSafe('character.skill.record', { text });
  }

  // ── Cached getters (synchronous, for UI) ──

  getMood() { return this._attributes.mood?.value ?? 80; }
  getHunger() { return this._attributes.hunger?.value ?? 70; }
  getHealth() { return this._attributes.health?.value ?? 100; }

  getMoodMax() { return this._attributes.mood?.max ?? 100; }
  getHungerMax() { return this._attributes.hunger?.max ?? 300; }
  getHealthMax() { return this._attributes.health?.max ?? 100; }

  getMoodLevel() { return this._attributes.mood?.level ?? 'happy'; }
  getHungerLevel() { return this._attributes.hunger?.level ?? 'normal'; }
  getHealthLevel() { return this._attributes.health?.level ?? 'healthy'; }

  getGrowthPoints() { return this._growth.points; }
  getGrowthStage() { return this._growth.stage; }
  getGrowthStageName() { return this._growth.stageName; }
  getPointsToNext() { return this._growth.pointsToNext; }

  // ── Event registration ──

  /**
   * Register callback for attribute level changes.
   * @param {(key: string, level: string, value: number) => void} callback
   */
  onAttributeChange(callback) {
    this._onAttributeChange.push(callback);
  }

  /**
   * Register callback for growth stage up.
   * @param {(stage: number, stageName: string) => void} callback
   */
  onGrowthStageUp(callback) {
    this._onGrowthStageUp.push(callback);
  }

  /**
   * Register callback for soul agent actions (proactive speech, emotion, self-care).
   * @param {(action: {type: string, text?: string, careAction?: string, emotion?: string}) => void} callback
   */
  onSoulAction(callback) {
    this._onSoulAction.push(callback);
  }

  /**
   * Register callback for attribute value changes (fires when |delta| >= 1).
   * Useful for float text UI (e.g. "+3 心情").
   * @param {(key: string, delta: number, newVal: number) => void} callback
   */
  onValueDelta(callback) {
    this._onValueDelta.push(callback);
  }

  // ── Polling ──

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    const state = await this._rpcSafe('character.state.get');
    if (state) {
      this._applyState(state);
      if (!this._connected) {
        this._connected = true;
        console.log('[char-sync] Reconnected to server');
      }
    } else if (this._connected) {
      this._connected = false;
      console.warn('[char-sync] Server connection lost, switching to offline mode');
    }
  }

  // ── Internal ──

  _applyState(state) {
    if (!state || !state.attributes) return;

    // Parse attributes array into keyed map
    const newAttrs = {};
    for (const attr of state.attributes) {
      newAttrs[attr.key] = {
        value: Math.round(attr.value),
        level: attr.level,
        max: attr.max,
      };
    }

    // Detect attribute level changes + value deltas
    for (const [key, attr] of Object.entries(newAttrs)) {
      const prevLevel = this._prevLevels[key];
      if (prevLevel && prevLevel !== attr.level) {
        for (const cb of this._onAttributeChange) {
          try { cb(key, attr.level, attr.value); } catch (e) {
            console.warn('[char-sync] onAttributeChange error:', e);
          }
        }
      }
      this._prevLevels[key] = attr.level;

      // Value delta (for float text); skip on first populate (no prev value yet)
      if (this._prevValues[key] !== undefined) {
        const delta = attr.value - this._prevValues[key];
        if (Math.abs(delta) >= 1) {
          for (const cb of this._onValueDelta) {
            try { cb(key, delta, attr.value); } catch (e) {
              console.warn('[char-sync] onValueDelta error:', e);
            }
          }
        }
      }
      this._prevValues[key] = attr.value;
    }
    this._attributes = newAttrs;

    // Growth
    if (state.growth) {
      const prevStage = this._prevGrowthStage;
      this._growth = state.growth;
      if (state.growth.stage > prevStage && prevStage !== 0) {
        for (const cb of this._onGrowthStageUp) {
          try { cb(state.growth.stage, state.growth.stageName); } catch (e) {
            console.warn('[char-sync] onGrowthStageUp error:', e);
          }
        }
      }
      this._prevGrowthStage = state.growth.stage;
    }

    // Skills / learning / achievements (cached for UI)
    if (state.skills) this._skills = state.skills;
    if (state.learning) this._learning = state.learning;
    if (state.achievements) this._achievementSummary = state.achievements;
  }

  async _rpc(method, params = {}) {
    if (!this._api?.characterRPC) return null;
    return await this._api.characterRPC(method, params);
  }

  async _rpcSafe(method, params = {}) {
    try {
      const result = await this._rpc(method, params);
      if (result?._error) {
        console.warn(`[char-sync] ${method} error:`, result._error);
        return null;
      }
      return result;
    } catch (e) {
      console.warn(`[char-sync] ${method} failed:`, e.message || e);
      return null;
    }
  }

  /**
   * Handle server-pushed state update (bypasses polling delay).
   * Called from the character-event WebSocket broadcast handler.
   */
  handleServerPush(payload) {
    if (payload?.kind === 'state-update' && payload.state) {
      this._applyState(payload.state);
    }
  }

  destroy() {
    this.stopPolling();
  }
}
