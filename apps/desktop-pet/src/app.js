/**
 * app.js — OpenClaw Pet 入口
 *
 * 单进程一体化架构：
 * - 宠物动画 + 交互
 * - 聊天面板（双击打开，直接和内嵌 LLM 对话）
 * - 设置面板（右键 → 设置）
 *
 * 没有外部服务依赖，所有 AI 调用通过 IPC → 主进程 LLM Service
 */

import { SpriteSheet } from './pet/SpriteSheet.js';
import { PetRenderer } from './pet/PetRenderer.js';
import { StateMachine } from './pet/StateMachine.js';
import { Behaviors } from './pet/Behaviors.js';
import { MoodSystem } from './pet/MoodSystem.js';
import { DragHandler } from './interaction/DragHandler.js';
import { ClickHandler } from './interaction/ClickHandler.js';
import { ContextMenu } from './interaction/ContextMenu.js';
import { FeedingAnimator } from './pet/FeedingAnimator.js';
import { Bubble } from './ui/Bubble.js';
import { ChatPanel } from './ui/ChatPanel.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { IntimacySystem } from './pet/IntimacySystem.js';
import { FileDropHandler } from './interaction/FileDropHandler.js';
import { ToolStatusBar } from './ui/ToolStatusBar.js';
import { MiniCatSystem } from './pet/MiniCatSystem.js';
import { SkillPanel } from './ui/SkillPanel.js';
import { inferDomainFromText } from './pet/DomainSystem.js';
import { WorkspaceWatcher } from './pet/WorkspaceWatcher.js';
import { AgentConnections } from './ui/AgentConnections.js';
import { AgentStatsTracker } from './pet/AgentStatsTracker.js';
import { AchievementSystem } from './pet/AchievementSystem.js';
import { StreamingBubble } from './ui/StreamingBubble.js';
import { BottomChatInput } from './ui/BottomChatInput.js';
import { MarkdownPanel } from './ui/MarkdownPanel.js';
import { HungerSystem } from './pet/HungerSystem.js';
import { HealthSystem } from './pet/HealthSystem.js';
import { SkillSystem } from './pet/SkillSystem.js';
import { PetAI } from './pet/PetAI.js';
import { LearningSystem } from './pet/LearningSystem.js';
import { CourseGenerator } from './pet/CourseGenerator.js';
import { LearningStatusBar } from './ui/LearningStatusBar.js';
import { LearningEventScheduler } from './pet/LearningEventScheduler.js';
import { LearningChoiceUI } from './ui/LearningChoiceUI.js';
import { MemoryGraph } from './pet/MemoryGraph.js';
import { MemoryGraphPanel } from './ui/MemoryGraphPanel.js';

class OpenClawPet {
  constructor() {
    this.canvas = document.getElementById('pet-canvas');
    this.bubbleContainer = document.getElementById('bubble-container');
    this.electronAPI = window.electronAPI || null;

    this.kittenSheet = new SpriteSheet();
    this.idleSheet = new SpriteSheet();
    // 额外动画 spritesheets
    this.sleepEnterSheet = new SpriteSheet();
    this.sleepLoopSheet = new SpriteSheet();
    this.sleepExitSheet = new SpriteSheet();
    this.workEnterSheet = new SpriteSheet();
    this.workLoopSheet = new SpriteSheet();
    this.workExitSheet = new SpriteSheet();
    this.swingEnterSheet = new SpriteSheet();
    this.swingLoopSheet = new SpriteSheet();
    this.swingExitSheet = new SpriteSheet();
    this.clickReactSheet = new SpriteSheet();
    this.dragSheet = new SpriteSheet();
    this.happySheet = new SpriteSheet();
    this.idleSneezeSheet = new SpriteSheet();
    this.idleTripSheet = new SpriteSheet();
    this.idleButterflySheet = new SpriteSheet();
    this.idleEarTwitchSheet = new SpriteSheet();
    this.idleYawnSheet = new SpriteSheet();
    this.stateMachine = new StateMachine();
    this.moodSystem = new MoodSystem();
    this.hungerSystem = new HungerSystem();
    this.healthSystem = new HealthSystem();
    this.skillSystem = new SkillSystem();
    this.petAI = null; // 初始化在 init() 后（需要 electronAPI）
    this.renderer = null;
    this.behaviors = null;
    this.bubble = null;
    this.chatPanel = null;
    this.settingsPanel = null;

    this.feedingAnimator = null;
    this.dragHandler = null;
    this.clickHandler = null;
    this.contextMenu = null;
    this.intimacySystem = null;
    this.fileDropHandler = null;
    this.toolStatusBar = null;
    this.miniCatSystem = null;
    this.skillPanel = null;
    this.workspaceWatcher = null;
    this.agentConnections = null;
    this.agentStatsTracker = null;
    this.achievementSystem = null;
    this.streamingBubble = null;
    this.markdownPanel = null;
    this.bottomChatInput = null;
    this.learningSystem = null;
    this.courseGenerator = null;

    this._lastTime = 0;
    this._chatCompletionCount = 0;
    this._running = false;
    this._proactiveTimer = null;
    this._lastAppReaction = 0;    // 窗口感知冷却
    this._dockingEnabled = false;  // 窗口停靠状态
  }

  async init() {
    console.log('🐱 OpenClaw Pet initializing...');

    // 1. 并行加载 spritesheet（成年猫 + 幼猫 + 姿势动画）
    const spritePath = '../assets/sprites/placeholder/';
    try {
      await Promise.all([
        this.kittenSheet.load(spritePath + 'spritesheet-kitten.png', spritePath + 'spritesheet-kitten.json')
          .catch(() => console.warn('⚠️ Kitten spritesheet not found, using adult as fallback')),
        this.sleepEnterSheet.load(spritePath + 'sleep_enter.png', spritePath + 'sleep_enter.json')
          .catch(() => console.warn('⚠️ sleep_enter spritesheet not found')),
        this.sleepLoopSheet.load(spritePath + 'sleep_loop.png', spritePath + 'sleep_loop.json')
          .catch(() => console.warn('⚠️ sleep_loop spritesheet not found')),
        this.sleepExitSheet.load(spritePath + 'sleep_exit.png', spritePath + 'sleep_exit.json')
          .catch(() => console.warn('⚠️ sleep_exit spritesheet not found')),
        this.workEnterSheet.load(spritePath + 'work_enter.png', spritePath + 'work_enter.json')
          .catch(() => console.warn('⚠️ work_enter spritesheet not found')),
        this.workLoopSheet.load(spritePath + 'work_loop.png', spritePath + 'work_loop.json')
          .catch(() => console.warn('⚠️ work_loop spritesheet not found')),
        this.workExitSheet.load(spritePath + 'work_exit.png', spritePath + 'work_exit.json')
          .catch(() => console.warn('⚠️ work_exit spritesheet not found')),
        this.swingEnterSheet.load(spritePath + 'swing_enter.png', spritePath + 'swing_enter.json')
          .catch(() => console.warn('⚠️ swing_enter spritesheet not found')),
        this.swingLoopSheet.load(spritePath + 'swing_loop.png', spritePath + 'swing_loop.json')
          .catch(() => console.warn('⚠️ swing_loop spritesheet not found')),
        this.swingExitSheet.load(spritePath + 'swing_exit.png', spritePath + 'swing_exit.json')
          .catch(() => console.warn('⚠️ swing_exit spritesheet not found')),
        this.clickReactSheet.load(spritePath + 'click_react.png', spritePath + 'click_react.json')
          .catch(() => console.warn('⚠️ click_react spritesheet not found')),
        this.dragSheet.load(spritePath + 'drag.png', spritePath + 'drag.json')
          .catch(() => console.warn('⚠️ drag spritesheet not found')),
        this.happySheet.load(spritePath + 'happy.png', spritePath + 'happy.json')
          .catch(() => console.warn('⚠️ happy spritesheet not found')),
        this.idleSneezeSheet.load(spritePath + 'idle_sneeze.png', spritePath + 'idle_sneeze.json')
          .catch(() => console.warn('⚠️ idle_sneeze spritesheet not found')),
        this.idleTripSheet.load(spritePath + 'idle_trip.png', spritePath + 'idle_trip.json')
          .catch(() => console.warn('⚠️ idle_trip spritesheet not found')),
        this.idleButterflySheet.load(spritePath + 'idle_butterfly.png', spritePath + 'idle_butterfly.json')
          .catch(() => console.warn('⚠️ idle_butterfly spritesheet not found')),
        this.idleEarTwitchSheet.load(spritePath + 'idle_ear_twitch.png', spritePath + 'idle_ear_twitch.json')
          .catch(() => console.warn('⚠️ idle_ear_twitch spritesheet not found')),
        this.idleYawnSheet.load(spritePath + 'idle_yawn.png', spritePath + 'idle_yawn.json')
          .catch(() => console.warn('⚠️ idle_yawn spritesheet not found')),
        this.idleSheet.load(spritePath + 'idle.png', spritePath + 'idle.json')
          .catch(() => console.warn('⚠️ idle spritesheet not found')),
      ]);
      console.log('✅ Spritesheets loaded');
    } catch (e) {
      console.error('❌ Failed to load spritesheet:', e);
      this._showFallback();
      return;
    }

    // 2. 亲密度系统（需要在渲染器之前初始化，以获取当前阶段）
    this.intimacySystem = new IntimacySystem();

    // 3. 初始化渲染器（传入幼猫 sheet）
    this.renderer = new PetRenderer(this.canvas, this.kittenSheet, 960);
    this.renderer.setGrowthStage(this.intimacySystem.stage);

    // 3a. 注册额外 spritesheet 和复合动画
    this.renderer.registerSheet('sleep_enter', this.sleepEnterSheet);
    this.renderer.registerSheet('sleep_loop', this.sleepLoopSheet);
    this.renderer.registerSheet('sleep_exit', this.sleepExitSheet);
    this.renderer.registerSheet('work_enter', this.workEnterSheet);
    this.renderer.registerSheet('work_loop', this.workLoopSheet);
    this.renderer.registerSheet('work_exit', this.workExitSheet);
    this.renderer.registerSheet('swing_enter', this.swingEnterSheet);
    this.renderer.registerSheet('swing_loop', this.swingLoopSheet);
    this.renderer.registerSheet('swing_exit', this.swingExitSheet);
    this.renderer.registerSheet('click_react', this.clickReactSheet);
    this.renderer.registerSheet('drag', this.dragSheet);
    this.renderer.registerSheet('happy', this.happySheet);
    this.renderer.registerSheet('idle_sneeze', this.idleSneezeSheet);
    this.renderer.registerSheet('idle_trip', this.idleTripSheet);
    this.renderer.registerSheet('idle_butterfly', this.idleButterflySheet);
    this.renderer.registerSheet('idle_ear_twitch', this.idleEarTwitchSheet);
    this.renderer.registerSheet('idle_yawn', this.idleYawnSheet);
    this.renderer.registerSheet('idle', this.idleSheet);
    this.renderer.registerCompound('sleep', 'sleep_enter', 'sleep_loop', 'sleep_exit');
    this.renderer.registerCompound('work', 'work_enter', 'work_loop', 'work_exit');
    this.renderer.registerCompound('swing', 'swing_enter', 'swing_loop', 'swing_exit');

    // 3b. 喂食动画
    this.feedingAnimator = new FeedingAnimator(this.renderer, this.stateMachine);

    // 4. 获取屏幕尺寸
    let screenWidth = 800;
    if (this.electronAPI) {
      try {
        const size = await this.electronAPI.getScreenSize();
        screenWidth = size.width;
      } catch (e) {}
    }

    // 5. 行为系统
    this.behaviors = new Behaviors(this.stateMachine, this.renderer, {
      screenWidth,
      walkSpeed: 1.5,
      minIdleTime: 4000,
      maxIdleTime: 12000,
    });

    // 6. UI 组件
    this.bubble = new Bubble(this.bubbleContainer);
    const petArea = document.getElementById('pet-area');
    this.streamingBubble = new StreamingBubble(petArea, this.bubble);
    this.markdownPanel = new MarkdownPanel(petArea, this.electronAPI);
    this.chatPanel = new ChatPanel(this.electronAPI, this.stateMachine, this.bubble);
    this.settingsPanel = new SettingsPanel(this.electronAPI);

    // 6a2. 底部快捷聊天
    this.bottomChatInput = new BottomChatInput(
      petArea,
      this.electronAPI, this.stateMachine, this.streamingBubble, this.markdownPanel
    );

    // 6b. 文件拖拽分析（需在 bubble/chatPanel 初始化之后）
    this.fileDropHandler = new FileDropHandler(
      this.canvas, this.electronAPI, this.stateMachine, this.bubble,
      this.chatPanel, this.intimacySystem
    );

    // 6d. 边缘反应
    this.behaviors.onEdgeReaction((edge) => {
      if (this.bubble.isVisible() || this.streamingBubble?.isVisible()) return;
      const msgs = {
        left: ['撞到了喵！>_<', '这边走不了了...', '哎呀，墙壁！'],
        right: ['到头了喵！', '碰壁了！>_<', '(碰) 好疼~'],
      };
      const pool = msgs[edge];
      this.bubble.show(pool[Math.floor(Math.random() * pool.length)], 2000);
    });

    // 6e. 边缘吸附 + 停靠状态气泡
    this.stateMachine.on('stateChange', ({ to }) => {
      if (to === 'edge_idle' && this.behaviors.edgeSnapped) {
        const msgs = {
          left: '靠在这里休息~ 🐾', right: '在这里看风景~ 🌟',
          top: '挂在上面啦！😸', bottom: '坐在这里不错~ ✨',
        };
        this.bubble.show(msgs[this.behaviors.edgeSnapped], 2500);
      }
    });

    // 6e2. 养成系统行为联动（状态显示在右键菜单中）
    // 饱腹变化
    this.hungerSystem.onChange((level, _hunger) => {
      if (level === 'starving') {
        this.bubble.show('呜...好饿喵 🥺', 4000);
        this.stateMachine.transition('sad', { force: true, duration: 2000 });
      } else if (level === 'hungry') {
        this.bubble.show('主人，我有点饿了...', 3000);
      } else if (level === 'full') {
        this.bubble.show('吃饱了！好满足～ 😋', 2500);
      }
    });

    // 健康变化
    this.healthSystem.onChange((level, _health) => {
      if (level === 'sick') {
        this.bubble.show('感觉有点不舒服... 🤒', 4000);
        this.stateMachine.transition('sad', { force: true, duration: 3000 });
      } else if (level === 'healthy') {
        this.bubble.show('感觉好多了喵！', 2500);
        this.stateMachine.transition('happy', { force: true, duration: 2000 });
      }
    });

    // 6f. 头顶状态条
    this.toolStatusBar = new ToolStatusBar(document.getElementById('pet-area'));

    // 6f2. 底部学习进度横幅
    this.learningStatusBar = new LearningStatusBar(document.getElementById('pet-area'));

    // 6g. 小分身系统
    this.miniCatSystem = new MiniCatSystem(
      document.getElementById('pet-area'),
      this.spriteSheet,
      this.electronAPI
    );
    this.miniCatSystem.start();

    // 6h. 技能系统（工具熟练度 + 领悟积累）
    this.skillSystem.onUnlock(({ toolName, stars, isNew }) => {
      const gain = isNew ? 5 : stars === 3 ? 15 : 8;
      this.intimacySystem.gain(gain);
      const msgs = isNew
        ? [`解锁了新技能：${toolName}！✨`, `喵！${toolName} 好厉害！`]
        : [`${toolName} 越用越熟练了！${'★'.repeat(stars)}`, `${toolName} 升星啦！喵～`];
      this.bubble.show(msgs[Math.floor(Math.random() * msgs.length)], 3000);
      this.stateMachine.transition('happy', { force: true, duration: 3000 });
      this.achievementSystem?.check();
    });

    // 6h1. 宠物属性升级通知
    this.skillSystem.onAttrLevelUp(({ name, level }) => {
      this.bubble.show(`${name} 提升到 Lv.${level} 了！✨`, 4000);
      this.stateMachine.transition('happy', { force: true, duration: 2000 });
    });

    // 6h2. Agent 战绩追踪
    this.agentStatsTracker = new AgentStatsTracker();

    // 6h3. 成就系统
    this.achievementSystem = new AchievementSystem(this.skillSystem, this.intimacySystem);
    this.achievementSystem.onUnlock((ach) => {
      this.bubble.show(`🏆 成就解锁：${ach.name}！${ach.icon}`, 4000);
      this.stateMachine.transition('happy', { force: true, duration: 3000 });
      if (ach.intimacyBonus > 0) this.intimacySystem.gain(ach.intimacyBonus);
    });
    this.achievementSystem.setContext({
      miniCatSystem: this.miniCatSystem,
      agentStatsTracker: this.agentStatsTracker,
    });

    // 6h4. 技能图鉴（注入所有子系统）
    this.skillPanel = new SkillPanel(
      this.electronAPI, this.skillSystem,
      this.agentStatsTracker, this.achievementSystem
    );

    // 6h5. 学习系统
    this.learningSystem = new LearningSystem(this.hungerSystem, this.moodSystem);
    this.courseGenerator = new CourseGenerator(this.electronAPI);

    // 注入到 SkillPanel
    this.skillPanel.setLearning(
      this.learningSystem,
      this.courseGenerator,
      (courseId) => this._startLearning(courseId)
    );

    // 6h6. 学习互动事件
    this.learningChoiceUI = new LearningChoiceUI(petArea);
    this.learningEventScheduler = new LearningEventScheduler({
      petAI: this.petAI,
      bubble: this.bubble,
      markdownPanel: this.markdownPanel,
      stateMachine: this.stateMachine,
      moodSystem: this.moodSystem,
      intimacySystem: this.intimacySystem,
      electronAPI: this.electronAPI,
      choiceUI: this.learningChoiceUI,
    });

    // 学习回调
    this.learningSystem.onLessonComplete((result) => {
      this.learningEventScheduler?.stop();
      this.behaviors.start();
      this.learningStatusBar.hide();
      this.stateMachine.transition('happy', { force: true, duration: 3000 });
      // 课程完成 → 领域活动（权重 3，高于普通对话的 1）
      this.skillSystem.recordDomainActivity(result.categoryName, result.courseTitle, 3);
      this.intimacySystem.gain(3);

      // 写入 OpenClaw 记忆
      const completeEvent = `[event:learning-complete] 宠物完成了「${result.courseTitle}」一节学习（${result.categoryName}领域），经验 +${result.xpGained}`;
      Promise.all([
        this.electronAPI?.appendAgentSession?.(completeEvent),
        this.electronAPI?.appendAgentMemory?.(completeEvent),
      ]).catch(() => {});

      // 立即显示结果气泡，PetAI 返回后再补一条反应
      const fragMsg = result.gotFragment
        ? `获得了技能碎片！(${result.fragmentProgress})`
        : `没有获得碎片...继续加油！(${result.fragmentProgress})`;
      this.bubble.show(`学完了！经验 +${result.xpGained} ${fragMsg}`, 5000);
      if (this.petAI && !this.petAI.isBusy) {
        this.petAI.generateLearningReaction('complete', result.courseTitle, result.categoryName).then(text => {
          if (!text) return;
          setTimeout(() => this.bubble.show(text, 5000), 5200);
          const reactionEvent = `[pet:reaction] ${text}`;
          Promise.all([
            this.electronAPI?.appendAgentSession?.(reactionEvent),
            this.electronAPI?.appendAgentMemory?.(reactionEvent),
          ]).catch(() => {});
        });
      }
    });

    this.learningSystem.onCourseComplete((course) => {
      this.intimacySystem.gain(15);
      this.bubble.show(`恭喜！「${course.title}」毕业了！🎓`, 6000);
      this.stateMachine.transition('happy', { force: true, duration: 4000 });

      // 生成 SKILL.md（如果 PetAI 可用）
      if (this.electronAPI?.writeSkillFile && course.skillContent) {
        const skillName = `learned-${course.title.replace(/\s+/g, '-')}`;
        const skillMd = `# ${course.title}\n\n${course.description || ''}\n\n${course.skillContent}`;
        this.electronAPI.writeSkillFile(skillName, skillMd).catch(() => {});
      }
    });

    this.learningSystem.onLessonInterrupt(({ courseTitle, reason, categoryName }) => {
      this.learningEventScheduler?.stop();
      this.behaviors.start();
      this.learningStatusBar.hide();
      this.stateMachine.transition('sad', { force: true, duration: 2000 });

      const interruptEvent = `[event:learning-interrupt] 宠物学习「${courseTitle}」被中断，原因：${reason}`;
      Promise.all([
        this.electronAPI?.appendAgentSession?.(interruptEvent),
        this.electronAPI?.appendAgentMemory?.(interruptEvent),
      ]).catch(() => {});

      this.bubble.show(`学习中断了...${reason} 😿`, 4000);
    });

    this.learningSystem.onLevelUp(({ categoryName, level }) => {
      this.bubble.show(`${categoryName} 升到 Lv.${level} 了！📈`, 4000);
    });

    // 离线检查：学习必须在线完成，退出即中断
    const offlineCheck = this.learningSystem.checkOfflineLesson();
    if (offlineCheck.resumed && offlineCheck.interrupted) {
      this.bubble.show(`「${offlineCheck.lesson.courseTitle}」学习中断了，下次要坚持到底喵~ 😿`, 5000);
    }

    // 6i. 多 Agent 协作可视化
    this.agentConnections = new AgentConnections(
      document.getElementById('pet-area'),
      this.miniCatSystem,
      this.agentStatsTracker
    );

    // 恢复 chat 计数
    this._chatCompletionCount = parseInt(localStorage.getItem('pet-chat-count') || '0');

    // 6k. PetAI + 领悟系统
    if (this.electronAPI) {
      this.petAI = new PetAI(this.electronAPI);
      this.skillSystem.onEpiphany(({ domainName, recentTopics }) => {
        this._handleEpiphany(domainName, recentTopics);
      });
    }

    // 6l. 记忆图谱
    if (this.electronAPI) {
      this.memoryGraph = new MemoryGraph(this.electronAPI);
      this.memoryGraphPanel = new MemoryGraphPanel(this.memoryGraph);
      this.chatPanel.setMemoryGraph(this.memoryGraph);
    }

    // 6j. 工作区感知
    this.workspaceWatcher = new WorkspaceWatcher();
    this.workspaceWatcher.onChange((info) => {
      if (this.bubble.isVisible() || this.chatPanel.isOpen) return;
      const { category, project, file } = info;
      if (category === 'code_editor' && project) {
        if (Math.random() > 0.3) return;
        const msgs = [
          `在写 ${project} 呢~ 需要帮忙吗？💻`,
          `${project} 进展顺利吗？我看着呢~`,
          `${file ? file + ' ' : ''}写代码好厉害！`,
        ];
        this.bubble.show(msgs[Math.floor(Math.random() * msgs.length)], 4000);
        this.stateMachine.transition('idle_ear_twitch', { force: true, duration: 2000 });
        return;
      }
      if (category === 'terminal' && project) {
        if (Math.random() > 0.2) return;
        this.bubble.show(`在 ${project} 跑命令~ 加油！⌨️`, 3000);
      }
    });

    // 7. 交互处理器
    this.dragHandler = new DragHandler(
      this.canvas, this.stateMachine, this.behaviors, this.electronAPI
    );

    this.clickHandler = new ClickHandler(
      this.canvas, this.stateMachine, this.behaviors, {
        onSingleClick: () => {
          this.moodSystem.gain(3);
          this.intimacySystem.gain(1);
          const level = this.moodSystem.getLevel();
          const greets = level === 'sad'
            ? ['...喵', '(T_T)', '嗯...', '理我一下嘛']
            : ['喵~ ❤️', '嗯？', '摸摸~', '(=^・ω・^=)', '在呢~'];
          this.bubble.show(greets[Math.floor(Math.random() * greets.length)], 2000);
        },
        onDoubleClick: () => {
          if (this.settingsPanel.isOpen) this.settingsPanel.close();
          if (this.skillPanel.isOpen) this.skillPanel.close();
          if (this.bottomChatInput.isOpen) this.bottomChatInput.close();
          this.chatPanel.toggle();
        },
        onLongPress: () => {
          // 摸头！
          this.moodSystem.gain(15);
          this.intimacySystem.gain(5);
          this.behaviors.recordInteraction();
          const purrs = ['咕噜噜~ 😻', '好舒服喵~', '再摸摸！(=^ω^=)', '呼噜呼噜...', '主人真好~ ❤️', '喵呜~'];
          this.bubble.show(purrs[Math.floor(Math.random() * purrs.length)], 3000);
          this.stateMachine.transition('happy', { force: true, duration: 3000 });
        }
      }
    );

    if (this.electronAPI) {
      const api = this.electronAPI;
      this.contextMenu = new ContextMenu(this.canvas, [
        { icon: '💬', label: '打开聊天',   action: () => this.chatPanel.toggle() },
        { icon: '⚙️', label: '设置',       action: () => { this.chatPanel.isOpen && this.chatPanel.closeQuiet(); this.skillPanel.isOpen && this.skillPanel.closeQuiet(); this.memoryGraphPanel?.isOpen && this.memoryGraphPanel.closeQuiet(); this.settingsPanel.open(); } },
        { icon: '📖', label: '图鉴',       action: () => { this.chatPanel.isOpen && this.chatPanel.closeQuiet(); this.settingsPanel.isOpen && this.settingsPanel.closeQuiet(); this.memoryGraphPanel?.isOpen && this.memoryGraphPanel.closeQuiet(); this.skillPanel.toggle(); } },
        { icon: '🧠', label: '记忆图谱',   action: () => { this.chatPanel.isOpen && this.chatPanel.closeQuiet(); this.settingsPanel.isOpen && this.settingsPanel.closeQuiet(); this.skillPanel.isOpen && this.skillPanel.closeQuiet(); this.memoryGraphPanel?.toggle(); } },
        { type: 'separator' },
        { icon: '🍤', label: '喂零食',     action: () => { if (!this.feedingAnimator.isPlaying) { this.behaviors.recordInteraction(); this.feedingAnimator.play(() => { this.moodSystem.gain(20); this.hungerSystem.feedSnack(); this.intimacySystem.gain(10); this.bubble.show(['好吃！~ 😋','喵呜~ 谢谢主人！','啊好香！还有吗！'][Math.floor(Math.random()*3)], 3000); }); } } },
        { icon: '📚', label: '去学习',     action: () => { this.chatPanel.isOpen && this.chatPanel.closeQuiet(); this.settingsPanel.isOpen && this.settingsPanel.closeQuiet(); this.skillPanel.openToLearning(); } },
        { type: 'separator' },
        { icon: '📌', label: '置顶',       action: () => api.toggleAlwaysOnTop?.() },
        { type: 'separator' },
        { icon: '🗑️', label: '清空对话',   action: () => { api.clearChatHistory?.(); this.bubble.show('对话已清空~ 重新开始吧！', 2000); } },
        { icon: '🔧', label: '开发者工具', action: () => api.openDevTools?.() },
        { type: 'separator' },
        { icon: '❌', label: '退出',       action: () => api.appQuit?.() },
      ], () => ({
        hunger: this.hungerSystem.getHunger(),
        mood:   this.moodSystem.getMood(),
        health: this.healthSystem.getHealth(),
      }), {
        onOpen:  () => this.electronAPI?.setIgnoreMouse(false),
        onClose: () => this._updateMousePassthrough(),
      });
    }

    // 7. 鼠标穿透
    this._setupMousePassthrough();

    // 8. 心情值变化响应
    this.moodSystem.onChange((level, _mood) => {
      if (level === 'sad') {
        this.bubble.show('主人...你不陪我吗 🥺', 4000);
        this.stateMachine.transition('sad', { force: true, duration: 2000 });
      } else if (level === 'joyful') {
        this.bubble.show('今天好开心！❤️', 2500);
        this.stateMachine.transition('happy', { force: true, duration: 3000 });
      }
    });


    // 9. 亲密度里程碑
    this.intimacySystem.onMilestone((stage, info) => {
      this.bubble.show(info.milestoneMsg, 5000);
      this.stateMachine.transition('happy', { force: true, duration: 3000 });
      this.renderer.setGrowthStage(stage);
    });

    // 10. 监听主进程事件
    this._setupMainProcessEvents();

    // 10. 启动
    this.renderer.start();
    this.behaviors.start();
    this._startMainLoop();
    this._startProactiveTimer();

    // 开场问候（根据时间 + 上次登录）
    setTimeout(async () => {
      const greeting = this._buildGreeting();
      this.bubble.show(greeting, 4000);
      this.stateMachine.transition('happy', { force: true, duration: 3000 });
    }, 800);

    console.log('✅ OpenClaw Pet ready!');
  }

  /**
   * 根据时间和上次登录时间生成开场问候语
   */
  _buildGreeting() {
    const now = Date.now();
    const lastLaunch = parseInt(localStorage.getItem('pet-last-launch') || '0');
    const hoursSince = (now - lastLaunch) / 3600000;
    localStorage.setItem('pet-last-launch', String(now));

    const stage = this.intimacySystem?.stage ?? 0;

    // 阶段 0：幼猫
    if (stage === 0) {
      return '主人...是你吗？(=•ω•=)';
    }

    // 阶段 3：心灵契合
    if (stage === 3) {
      return '终于等到你了，我心里一直有你喵 💖';
    }

    // 长时间未登录
    if (lastLaunch > 0 && hoursSince > 12) {
      if (stage === 2) {
        return `主人回来啦！等你好久了~ 😻 好 ${Math.round(hoursSince)} 小时没见了喵！`;
      }
      return `好久不见喵！等你 ${Math.round(hoursSince)} 小时了 🥺`;
    }

    // 阶段 2：亲密伙伴
    if (stage === 2) {
      const hour = new Date().getHours();
      const suffix = hour >= 5 && hour < 9   ? '今天也加油哦~ ☀️'
                   : hour >= 9 && hour < 12  ? '有什么需要帮忙的吗？😊'
                   : hour >= 12 && hour < 14 ? '吃饭了吗~'
                   : hour >= 14 && hour < 18 ? '在认真工作呢？'
                   : hour >= 18 && hour < 21 ? '辛苦了一天~'
                   : '别忘了休息哦 💤';
      return `主人回来啦！等你好久了~ 😻 ${suffix}`;
    }

    // 阶段 1：朋友（保持原有时段问候）
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 9)  return '早上好主人！今天也加油哦~ ☀️';
    if (hour >= 9 && hour < 12) return '上午好~ 有什么需要帮忙的吗？😊';
    if (hour >= 12 && hour < 14) return '午饭吃了吗主人~ 记得休息！🍱';
    if (hour >= 14 && hour < 18) return '下午好~ 专注工作中？我陪着你喵~';
    if (hour >= 18 && hour < 21) return '晚上好！辛苦了一天~ 🌙';
    if (hour >= 21 && hour < 24) return '好晚了喵... 别忘了休息哦 💤';
    return '深夜了... 主人要注意身体喵 🌛';
  }

  /**
   * 每 5 分钟检查：长时间无互动时主动打招呼
   */
  _startProactiveTimer() {
    this._proactiveTimer = setInterval(() => {
      if (!this._running) return;
      const idleMs = Date.now() - (this.behaviors.lastInteractionTime || Date.now());
      if (idleMs < 10 * 60 * 1000) return;        // 不足 10 分钟不触发
      if (this.bubble.isVisible()) return;          // 气泡正显示时不打扰
      if (this.streamingBubble?.isVisible()) return; // 流式回复中不打扰
      if (this.chatPanel.isOpen) return;            // 聊天中不触发
      if (this.bottomChatInput?.isOpen) return;     // 底部输入中不触发

      const msgs = [
        '主人~ 还在吗？(=TωT=)',
        '喂喂！不理我吗 🥺',
        '好无聊喵... 陪我玩玩嘛~',
        '你已经很久没搭理我了喵！',
        '(屁股蹭蹭) 注意到我了吗~',
      ];
      this.bubble.show(msgs[Math.floor(Math.random() * msgs.length)], 5000);
      this.stateMachine.transition('sad', { force: true, duration: 2000 });
    }, 5 * 60 * 1000);
  }

  /** 菜单关闭后恢复穿透状态（交给下一次 mousemove 精确判断） */
  _updateMousePassthrough() {
    this.electronAPI?.setIgnoreMouse(true);
  }

  _setupMousePassthrough() {
    if (!this.electronAPI) return;

    // 全局 mousemove：根据鼠标位置决定是否穿透
    // 面板区域 → 不穿透；canvas 非透明像素 → 不穿透；其他 → 穿透
    this._mouseMoveHandler = (e) => {
      // 1. 鼠标在打开的面板上 → 不穿透
      const chatPanel = document.getElementById('chat-panel');
      const settingsPanel = document.getElementById('settings-panel');
      const skillPanel = document.getElementById('skill-panel');
      // mini-cat 元素也需要阻止穿透
      const miniCatEl = e.target.closest?.('.mini-cat');
      const bottomChatEl = e.target.closest?.('.bottom-chat-input.open') || e.target.closest?.('.bottom-chat-toggle');
      const mdPanelEl = e.target.closest?.('.md-panel');
      const choiceUIEl = e.target.closest?.('.learning-choice-ui');
      const contextMenuEl = e.target.closest?.('.custom-context-menu');
      // 右键菜单展开中 → 全局禁止穿透，确保点击任何区域都能关闭菜单
      if (document.querySelector('.custom-context-menu')) {
        this.electronAPI.setIgnoreMouse(false);
        return;
      }
      const mgPanel = document.getElementById('memory-graph-panel');
      const isOverPanel =
        !!miniCatEl ||
        !!bottomChatEl ||
        !!mdPanelEl ||
        !!choiceUIEl ||
        !!contextMenuEl ||
        (chatPanel?.classList.contains('open') && chatPanel.contains(e.target)) ||
        (settingsPanel?.classList.contains('open') && settingsPanel.contains(e.target)) ||
        (skillPanel?.classList.contains('open') && skillPanel.contains(e.target)) ||
        (mgPanel?.classList.contains('open') && mgPanel.contains(e.target));

      if (isOverPanel) {
        this.electronAPI.setIgnoreMouse(false);
        return;
      }

      // 2. 鼠标在 canvas 上 → 检查像素透明度
      if (e.target === this.canvas) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        if (x >= 0 && y >= 0 && x < this.canvas.width && y < this.canvas.height) {
          const ctx = this.canvas.getContext('2d');
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          this.electronAPI.setIgnoreMouse(pixel[3] < 10);
        }
        return;
      }

      // 3. 其他区域（透明背景）→ 穿透
      this.electronAPI.setIgnoreMouse(true);
    };
    document.addEventListener('mousemove', this._mouseMoveHandler);
  }

  _setupMainProcessEvents() {
    if (!this.electronAPI) return;

    // 右键菜单 → 打开聊天
    this.electronAPI.onToggleChat(() => {
      if (this.settingsPanel.isOpen) this.settingsPanel.close();
      if (this.skillPanel.isOpen) this.skillPanel.close();
      this.chatPanel.toggle();
    });

    // 右键菜单 → 打开设置
    this.electronAPI.onOpenSettings(() => {
      if (this.chatPanel.isOpen) this.chatPanel.close();
      if (this.skillPanel.isOpen) this.skillPanel.close();
      this.settingsPanel.open();
    });

    // 右键菜单 → 打开技能面板
    this.electronAPI.onOpenSkills?.(() => {
      if (this.chatPanel.isOpen) this.chatPanel.close();
      if (this.settingsPanel.isOpen) this.settingsPanel.close();
      this.skillPanel.toggle();
    });

    // 右键菜单 → 调整大小
    this.electronAPI.onResizePet((size) => {
      this.canvas.width = size;
      this.canvas.height = size;
      this.renderer.renderSize = size;
    });

    // 对话被清空
    this.electronAPI.onChatCleared(() => {
      this.bubble.show('对话已清空~ 重新开始吧！', 2000);
    });

    // AI 聊天回复完成 → 亲密度 +3 + 饱腹 + 领域活动推断 + 成就检查
    this.electronAPI.onChatStream?.((payload) => {
      if (payload?.state === 'final') {
        this.intimacySystem.gain(3);
        const raw = payload.message;
        const msg = typeof raw === 'string' ? raw : (raw?.content ?? String(raw ?? ''));
        this.hungerSystem.onChatFinal(msg.length);
        this._chatCompletionCount++;
        localStorage.setItem('pet-chat-count', String(this._chatCompletionCount));
        this.achievementSystem?.check();

        // 根据对话内容推断领域，驱动技能领域积累
        const domain = inferDomainFromText(msg);
        if (domain) this.skillSystem.recordDomainActivity(domain, msg.slice(0, 60));

        // 记忆图谱提取
        if (this.memoryGraph) {
          const userMsg = this.chatPanel?.getLastUserMessage?.() || '';
          this.memoryGraph.enqueueExtraction(userMsg, msg);
        }
      }
    });

    // 喂零食 — 完整 4 阶段动画
    this.electronAPI.onFeedPet?.(() => {
      if (this.feedingAnimator.isPlaying) return; // 防止动画叠加
      this.behaviors.recordInteraction();
      this.feedingAnimator.play(() => {
        // 动画结束后：加心情 + 加饱腹 + 加亲密度 + 显示气泡
        this.moodSystem.gain(20);
        this.hungerSystem.feedSnack();
        this.intimacySystem.gain(10);
        const foods = ['好吃！~ 😋', '喵呜~ 谢谢主人！', '啊好香！还有吗！', '(=^・ω・^=) 满足了~', '最喜欢主人了！❤️'];
        this.bubble.show(foods[Math.floor(Math.random() * foods.length)], 3000);
      });
    });

    // 活动窗口感知
    this.electronAPI.onForegroundAppChanged?.((data) => {
      // 桌面有操作 → 重置睡眠计时
      this.behaviors.recordInteraction();

      // 停靠中 → 窗口切换自动解除
      if (this._dockingEnabled) {
        this._disableDocking();
        this.bubble.show('窗口切换了，我下来了喵~', 2000);
        return;
      }

      if (this.chatPanel.isOpen || this.bubble.isVisible()) return;
      if (this._lastAppReaction && Date.now() - this._lastAppReaction < 30000) return;

      const reactions = {
        code_editor: ['你在写代码呀！加油！💻', '认真coding中~ 我安静陪着你喵'],
        browser:     ['又在刷网页~ 😼', '看到什么有趣的了吗？'],
        chat:        ['在跟谁聊天呀？🤔', '不要忘了我喵！'],
        game:        ['在玩游戏！好嫉妒！🎮', '也带我玩嘛~'],
        terminal:    ['在敲命令行呢~ 酷！⌨️'],
        media:       ['在听音乐/看视频呢~ 🎵'],
        office:      ['在处理文档呢~ 📄', '辛苦了！'],
      };
      const pool = reactions[data.category];
      if (!pool || Math.random() > 0.4) return;

      this._lastAppReaction = Date.now();
      this.bubble.show(pool[Math.floor(Math.random() * pool.length)], 4000);
      this.stateMachine.transition('idle_ear_twitch', { force: true, duration: 2000 });

      // 工作区感知（精准项目/文件信息）
      this.workspaceWatcher?.handleAppChange(data);
    });

    // 窗口停靠开关
    this.electronAPI.onToggleDocking?.((enabled) => {
      if (enabled) {
        this._dockingEnabled = true;
        this.behaviors.setDocking(true);
        this.electronAPI.startDockTracking();
        this.stateMachine.transition('sit', { force: true });
        this.bubble.show('坐到窗口上面啦！😸', 2500);
      } else {
        this._disableDocking();
      }
    });

    // 停靠目标位置更新
    this.electronAPI.onDockTargetUpdate?.((update) => {
      if (!this._dockingEnabled) return;
      if (update.minimized) {
        this._disableDocking();
        this.bubble.show('窗口最小化了，我下来了喵~', 2000);
        return;
      }
      const { left, top, right } = update.rect;
      const petX = Math.round(left + (right - left) / 2 - 100);
      const petY = Math.max(0, Math.round(top - 250));
      this.electronAPI.setWindowPosition(petX, petY);
      this.behaviors.setPosition(petX, petY);
    });

    // Agent 事件分发 — 状态条 + 小分身 + 活动状态映射
    this.electronAPI.onAgentEvent?.((event) => {
      // 1. 分发给小分身系统
      this.miniCatSystem?.onAgentEvent(event);

      // 2. 工具调用 → 头顶状态条 + 工具图鉴统计（不再驱动技能领域）
      if (event.stream === 'tool') {
        const toolName = event.data?.tool || event.data?.name || 'working';
        if (event.data?.phase === 'start' || event.data?.status === 'running') {
          this.toolStatusBar.show(toolName);
          this.skillSystem.recordTool(toolName);

          // 子 session 工具追踪
          const isSubSession = event.sessionKey && !event.sessionKey.endsWith(':main');
          if (isSubSession) {
            const taskName = this.miniCatSystem?.miniCats.get(event.sessionKey)?.session?.derivedTitle || null;
            this.agentStatsTracker?.recordTool(event.sessionKey, toolName, taskName);
          }
        } else if (event.data?.phase === 'complete' || event.data?.phase === 'error') {
          this.toolStatusBar.hide();
        }
        this.achievementSystem?.check();
      }

      // 3. 生命周期 → 宠物动画 + Agent 完成追踪
      if (event.stream === 'lifecycle') {
        if (event.data?.phase === 'thinking' || event.data?.phase === 'running') {
          const interruptible = ['idle', 'idle_ear_twitch', 'idle_yawn', 'walk', 'sit', 'sleep'];
          if (interruptible.includes(this.stateMachine.currentState)) {
            this.stateMachine.transition('work', { force: true });
          }
        } else if (event.data?.phase === 'complete') {
          this.stateMachine.transition('happy', { force: true, duration: 3000 });
          this.bubble.show('任务完成了喵！✨', 2000);

          const isSubSession = event.sessionKey && !event.sessionKey.endsWith(':main');
          if (isSubSession) {
            this.agentStatsTracker?.recordComplete(event.sessionKey);
          }
          this.achievementSystem?.check();
        }
      }
    });

    // 剪贴板感知
    this.electronAPI.onClipboardChange?.((data) => {
      if (this.chatPanel.isOpen || this.bubble.isVisible()) return;
      const hints = {
        code:     '检测到代码~ 需要帮忙看看吗？🐾',
        error:    '好像是报错！我来帮你分析！😼',
        url:      '发现了一个链接 👀 要我帮你看看吗？',
        longtext: '复制了一大段文字，需要我帮你处理吗？',
      };
      const hint = hints[data.type];
      if (!hint) return;
      this.bubble.show(hint, 6000);
      this.stateMachine.transition('idle_ear_twitch', { force: true, duration: 2000 }); // 侧耳倾听
    });
  }

  /**
   * 领悟事件处理：发呆 → PetAI 生成 → 写入 Agent 记录 → 冒泡 → 技能图鉴
   */
  async _handleEpiphany(domainName, recentTopics) {
    if (!this.petAI || this.petAI.isBusy) return;

    // 进入发呆动画
    this.stateMachine.transition('idle', { force: true });

    // 调用 PetAI 生成领悟内容
    const result = await this.petAI.generateEpiphany(domainName, recentTopics);
    if (!result) return;

    const { bubble, skillName, skillTitle, skillDesc, skillContent, summary } = result;

    // 构建 SKILL.md 内容
    const skillMd = `---\nname: ${skillName}\ndescription: "${skillDesc}"\n---\n\n# ${skillTitle}\n\n${skillContent}\n`;

    // 并行写入：技能文件 + agent session + agent memory
    const eventText = `[event:skill-realized] 宠物领悟了「${skillTitle}」：${summary}`;
    await Promise.all([
      this.electronAPI.writeSkillFile(skillName, skillMd),
      this.electronAPI.appendAgentSession(eventText),
      this.electronAPI.appendAgentMemory(eventText),
    ]).catch((e) => console.warn('[epiphany] 写入失败:', e.message));

    // 存入技能图鉴
    this.skillSystem.addRealized({ skillName, skillTitle, skillDesc, skillContent, summary, domainName, realizedAt: Date.now() });

    // 渲染冒泡（使用模板）
    const bubbleText = SkillSystem.renderBubble(bubble);
    this.stateMachine.transition('happy', { force: true, duration: 2000 });
    setTimeout(() => this.bubble.show(bubbleText, 5000), 800);

    console.log(`[epiphany] 领悟了「${skillTitle}」(${skillName})`);
  }

  _startLearning(courseId) {
    const result = this.learningSystem.startLesson(courseId);
    if (!result.ok) {
      this.bubble.show(result.reason, 3000);
      return;
    }
    // 进入工作动画 + 锁定行为
    this.stateMachine.transition('work', { force: true });
    this.behaviors.stop();
    this.behaviors.recordInteraction();

    // 底部学习进度横幅
    this.learningStatusBar.show(
      result.lesson.courseTitle,
      () => this.learningSystem.getActiveLesson()?.remaining || 0,
      result.lesson.duration
    );

    // 启动学习互动事件调度
    const { courseTitle, categoryName } = result.lesson;
    this.learningEventScheduler?.start({
      courseTitle,
      categoryName,
      duration: result.lesson.duration,
      getElapsed: () => this.learningSystem.getActiveLesson()?.elapsed || 0,
    });

    // 写入 OpenClaw 记忆
    const startEvent = `[event:learning-start] 宠物开始学习「${courseTitle}」（${categoryName}领域）`;
    Promise.all([
      this.electronAPI?.appendAgentSession?.(startEvent),
      this.electronAPI?.appendAgentMemory?.(startEvent),
    ]).catch(() => {});

    // 立即显示占位气泡，PetAI 返回后再补一条反应
    this.bubble.show(`开始学习「${courseTitle}」了~ 📚`, 3000);
    if (this.petAI && !this.petAI.isBusy) {
      this.petAI.generateLearningReaction('start', courseTitle, categoryName).then(text => {
        if (!text) return;
        setTimeout(() => this.bubble.show(text, 5000), 3200);
        const reactionEvent = `[pet:reaction] ${text}`;
        Promise.all([
          this.electronAPI?.appendAgentSession?.(reactionEvent),
          this.electronAPI?.appendAgentMemory?.(reactionEvent),
        ]).catch(() => {});
      });
    }
  }

  _disableDocking() {
    this._dockingEnabled = false;
    this.behaviors.setDocking(false);
    this.electronAPI?.stopDockTracking();
    this.stateMachine.transition('idle', { force: true });
  }

  _startMainLoop() {
    this._running = true;
    this._lastTime = performance.now();
    let iconUpdateCounter = 0;

    const loop = (timestamp) => {
      if (!this._running) return;

      const deltaMs = timestamp - this._lastTime;
      this._lastTime = timestamp;

      this.stateMachine.update(deltaMs);
      this.behaviors.update(deltaMs);
      this.moodSystem.update(deltaMs);
      this.hungerSystem.update(deltaMs);
      this.healthSystem.update(deltaMs, this.hungerSystem.getLevel(), this.moodSystem.getLevel());
      this.learningSystem?.update(deltaMs);

      // 每 ~30 帧更新一次图标/朝向（避免每帧查询）
      if (++iconUpdateCounter >= 30) {
        iconUpdateCounter = 0;
        this._updateSideByPosition();
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  /** 根据窗口在屏幕的位置更新图标侧和宠物朝向 */
  async _updateSideByPosition() {
    if (!this.electronAPI?.getWindowPosition || !this.electronAPI?.getScreenSize) return;
    if (this._updatingSide) return; // 防止上一次 IPC 未完成时重叠调用
    this._updatingSide = true;
    try {
      const pos = await this.electronAPI.getWindowPosition();
      const scr = await this.electronAPI.getScreenSize();
      const centerX = pos.x + 128; // 窗口中心
      const isOnRight = centerX > scr.width / 2;
      const side = isOnRight ? 'left' : 'right';
      this.bottomChatInput?.updateSide(side);
      this.streamingBubble?.updateSide(side);
      // 宠物面向屏幕中心（走动时由 Behaviors 控制，不覆盖）
      if (this.stateMachine.getState() !== 'walk') {
        this.renderer?.setFlipX(isOnRight);
      }
    } catch {} finally {
      this._updatingSide = false;
    }
  }

  _showFallback() {
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = '#FFB464';
    ctx.fillRect(30, 30, 68, 68);
    ctx.fillStyle = '#333';
    ctx.font = '40px serif';
    ctx.textAlign = 'center';
    ctx.fillText('🐱', 64, 75);
  }

  destroy() {
    this._running = false;
    if (this._proactiveTimer) clearInterval(this._proactiveTimer);
    if (this._mouseMoveHandler) {
      document.removeEventListener('mousemove', this._mouseMoveHandler);
      this._mouseMoveHandler = null;
    }
    this.renderer?.destroy();
    this.behaviors?.destroy();
    this.stateMachine?.destroy();
    this.dragHandler?.destroy();
    this.clickHandler?.destroy();
    this.contextMenu?.destroy();
    this.fileDropHandler?.destroy();
    this.toolStatusBar?.destroy();
    this.learningStatusBar?.destroy();
    this.learningEventScheduler?.destroy();
    this.learningChoiceUI?.destroy();
    this.miniCatSystem?.destroy();
    this.skillPanel?.destroy();
    this.agentConnections?.destroy();
    this.workspaceWatcher = null;
    this.skillSystem = null;
    this.agentStatsTracker = null;
    this.achievementSystem = null;
    this.learningSystem = null;
    this.courseGenerator = null;
    this.bottomChatInput?.destroy();
    this.streamingBubble?.destroy();
    this.markdownPanel?.destroy();
    this.bubble?.destroy();
    this.chatPanel?.destroy();
    this.settingsPanel?.destroy();
  }
}

// 启动
const pet = new OpenClawPet();
pet.init().catch(e => console.error('Failed to initialize:', e));
window._pet = pet;
