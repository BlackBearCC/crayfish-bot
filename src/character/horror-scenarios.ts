/**
 * Horror Scenarios — Built-in scenario definitions for the Horror System
 *
 * Each scenario defines a self-contained horror story world:
 * worldview, NPCs, rules, win/lose conditions, and suggested skill checks.
 */

// ─── Types ───

export interface HorrorNPC {
  name: string;
  role: string;
  personality: string;
  isHostile: boolean;
}

export interface SkillCheckHint {
  situation: string;
  attribute: "logic" | "creativity" | "execution" | "empathy" | "sensitivity";
  dc: number;
  successHint: string;
  failureHint: string;
}

export interface HorrorScenario {
  id: string;
  title: string;
  hook: string;
  worldview: string;
  setting: string;
  npcs: HorrorNPC[];
  rules: string[];
  winConditions: string[];
  loseConditions: string[];
  checkHints: SkillCheckHint[];
  difficulty: 1 | 2 | 3;
  estimatedTurns: number;
  themes: string[];
}

// ─── Built-in Scenarios ───

export const BUILTIN_SCENARIOS: HorrorScenario[] = [
  {
    id: "midnight-elevator",
    title: "午夜电梯",
    hook: "加班后独自乘电梯，楼层数字开始不对劲……",
    worldview: `一栋普通的25层写字楼，但午夜12点后的电梯连接着不存在的楼层。
每到一层都是现实世界的某种扭曲镜像——办公室里的人在倒着走路、茶水间的水往上流、走廊无限延伸。
电梯里有一套隐藏规则，遵守则安全，违反则永远困在这栋楼里。
电梯管理员知道规则，但从不直说。`,
    setting: "现代城市，25层写字楼，封闭的电梯空间。午夜12:03，最后一个加班的人刚离开。",
    npcs: [
      {
        name: "电梯管理员",
        role: "穿灰色制服的老人，总是在微笑",
        personality: "说话含糊其辞，只用暗示和隐喻回答问题。知道所有规则但绝不会直说。偶尔会哼一首听不清的歌。如果被逼急了会沉默不语。",
        isHostile: false,
      },
      {
        name: "镜中人",
        role: "电梯镜子里的倒影，但动作有5秒延迟",
        personality: "不会说话，但会用动作暗示危险。有时候会做出宠物没有做过的动作——比如摇头、指向某个方向。",
        isHostile: false,
      },
    ],
    rules: [
      "电梯显示的楼层数字与实际楼层不符，每次停靠的规律需要推理",
      "电梯内的镜子反射有5秒延迟，镜中人偶尔会做出独立动作",
      "按下不存在的楼层按钮（如B3、26F）会触发异象",
      "电梯门开着时绝对不能背对门外",
      "每次违反规则，走廊会多出一扇不该存在的门",
    ],
    winConditions: [
      "找到真正的1楼出口（不是电梯显示的1楼）",
      "正确理解并遵守3条以上电梯规则",
    ],
    loseConditions: [
      "理智归零",
      "连续3次违反电梯规则（走廊出现3扇多余的门后，再也找不到出口）",
      "回合数耗尽时仍未逃出",
    ],
    checkHints: [
      {
        situation: "分析楼层数字的变化规律",
        attribute: "logic",
        dc: 4,
        successHint: "发现楼层按照某种数学规律跳变，推算出下一站",
        failureHint: "数字越看越混乱，开始头痛",
      },
      {
        situation: "感知电梯或走廊中的异常",
        attribute: "sensitivity",
        dc: 3,
        successHint: "注意到镜子反射有延迟，或察觉走廊尽头的微妙变化",
        failureHint: "总觉得哪里不对但说不上来，不安感加剧",
      },
      {
        situation: "与电梯管理员交流、套话",
        attribute: "empathy",
        dc: 5,
        successHint: "从老人含糊的话语中理解了一条关键规则",
        failureHint: "老人的回答让人更加困惑，他似乎在叹气",
      },
      {
        situation: "在紧急情况下快速反应",
        attribute: "execution",
        dc: 4,
        successHint: "及时做出正确动作，化解了危险",
        failureHint: "反应慢了半拍，付出了代价",
      },
      {
        situation: "想出非常规的脱困方法",
        attribute: "creativity",
        dc: 5,
        successHint: "灵机一动找到了意想不到的解法",
        failureHint: "想法不错但行不通，浪费了时间",
      },
    ],
    difficulty: 2,
    estimatedTurns: 25,
    themes: ["elevator", "urban", "psychological"],
  },

  {
    id: "classroom-that-wont-let-go",
    title: "回不去的教室",
    hook: "校园深夜，黑板上出现了不该存在的文字……",
    worldview: `一所普通的高中，但每到午夜，3楼的某间教室会"醒来"。
教室里的一切看起来正常，但细节是错的——课表上的科目不存在、窗外的操场比白天大了三倍、黑板上会自动出现文字。
这间教室困着一个"留级生"的执念——一个永远毕不了业的灵魂，它会出题考人，答对才能离开。
但题目不是普通的考试题，而是关于"这间教室"本身的谜题。`,
    setting: "现代高中，3楼尽头的教室。墙上的钟停在11:59。窗外月光异常明亮。",
    npcs: [
      {
        name: "留级生",
        role: "坐在最后一排角落的透明少年，穿着过时的校服",
        personality: "语气平静但透着悲伤。会出题考宠物，答对了会给线索，答错了会叹气说'又错了'。不会主动伤害人，但他的存在本身就在扭曲教室。渴望有人能'毕业'。",
        isHostile: false,
      },
      {
        name: "值日生",
        role: "在走廊上巡逻的影子，手里拿着扫帚",
        personality: "不说话，只会用扫帚敲地板发出节奏。如果有人试图从窗户或门硬闯出去，它会出现阻止。敲击的节奏其实是摩斯密码。",
        isHostile: true,
      },
    ],
    rules: [
      "教室门从内侧打不开，必须解开教室的谜题才能离开",
      "黑板上会自动出现文字，这些文字是解谜的关键线索",
      "窗外的风景每隔几分钟会变化，暗示时间在教室里是扭曲的",
      "课桌抽屉里的物品来自不同年代，可以组合使用",
      "留级生的题目有3次机会，3次都错教室会'重置'（理智大幅下降）",
    ],
    winConditions: [
      "解开3道谜题，帮助留级生'毕业'",
      "找到教室的'真正出口'（不是门或窗）",
    ],
    loseConditions: [
      "理智归零",
      "教室重置3次（留级生的题目累计答错9次）",
      "回合数耗尽",
    ],
    checkHints: [
      {
        situation: "分析黑板上的文字和课桌里的物品之间的关联",
        attribute: "logic",
        dc: 3,
        successHint: "发现了文字和物品之间的对应关系",
        failureHint: "线索太多太杂，越整理越混乱",
      },
      {
        situation: "回答留级生的谜题",
        attribute: "creativity",
        dc: 4,
        successHint: "给出了出人意料但正确的答案",
        failureHint: "答案不对，留级生低下了头",
      },
      {
        situation: "感知教室中时间扭曲的征兆",
        attribute: "sensitivity",
        dc: 3,
        successHint: "察觉到窗外风景变化的规律，推算出教室的时间周期",
        failureHint: "没注意到变化，错过了关键时间窗口",
      },
      {
        situation: "与留级生建立情感连接",
        attribute: "empathy",
        dc: 4,
        successHint: "理解了留级生的真正诉求，获得了额外线索",
        failureHint: "留级生沉默了，教室的温度似乎降低了",
      },
      {
        situation: "在教室重置时快速保护重要物品",
        attribute: "execution",
        dc: 5,
        successHint: "成功在重置前抢救了关键道具",
        failureHint: "手忙脚乱，什么都没保住",
      },
    ],
    difficulty: 1,
    estimatedTurns: 20,
    themes: ["school", "puzzle", "ghost"],
  },

  {
    id: "mirror-visitor",
    title: "镜中来客",
    hook: "浴室的镜子里，'你'开始做出不一样的动作……",
    worldview: `镜中世界是现实的完美镜像，但有自己的意志。
当镜中的"你"开始独立行动时，意味着镜界的边界正在崩塌。
镜中来客不是敌人——它是镜中世界派来的求助者，因为镜界正在被"裂缝"吞噬。
但如果现实世界的人太久注视镜子，自己也会被拉进镜中。
要拯救两个世界，必须在不被吞噬的前提下修复裂缝。`,
    setting: "一间普通的公寓，浴室、卧室衣柜镜、玄关穿衣镜。深夜，所有镜面同时起雾。",
    npcs: [
      {
        name: "镜中的自己",
        role: "镜子里的宠物倒影，但开始独立行动",
        personality: "说话时声音像从水底传来。焦急但努力保持冷静。用左右相反的手势交流。它能看到镜界中现实世界看不到的东西——裂缝的位置和形状。",
        isHostile: false,
      },
      {
        name: "裂缝",
        role: "镜面上不断扩大的黑色裂痕，会发出低频嗡鸣",
        personality: "没有智能，是纯粹的吞噬力量。靠近它会感到眩晕和恐惧。它会被某些声音吸引，也会被某些光源暂时驱退。",
        isHostile: true,
      },
      {
        name: "猫",
        role: "家里的猫，似乎能同时看到现实和镜界",
        personality: "会盯着裂缝的位置看。用行为暗示危险——弓背嘶嘶叫表示裂缝在扩大，蹭蹭主人表示安全。偶尔会走到镜子前，镜中也出现一只猫但颜色不同。",
        isHostile: false,
      },
    ],
    rules: [
      "连续注视同一面镜子超过30秒（约3个回合持续互动）会被逐渐拉入镜界",
      "镜中的自己只能通过镜面交流，声音模糊需要仔细辨认",
      "裂缝会从浴室镜向其他镜面蔓延，每3回合扩散一次",
      "修复裂缝需要在现实和镜界同时进行对应动作",
      "打碎镜子不会消灭裂缝，反而会让碎片变成新的入口",
      "家里的猫能看到裂缝但不能交流，只能通过行为推断",
    ],
    winConditions: [
      "修复3面镜子上的裂缝（浴室镜、衣柜镜、穿衣镜各一次）",
      "在不被吞噬的前提下帮助镜中的自己封印裂缝源头",
    ],
    loseConditions: [
      "理智归零",
      "被拉入镜界（连续3回合以上注视同一面镜子且未采取防护措施）",
      "所有3面镜子的裂缝完全扩散（约15回合不处理）",
      "回合数耗尽",
    ],
    checkHints: [
      {
        situation: "辨认镜中自己的模糊话语或手势",
        attribute: "sensitivity",
        dc: 4,
        successHint: "成功读懂了镜中自己的信息，获得裂缝位置线索",
        failureHint: "声音太模糊了，只听到片段",
      },
      {
        situation: "与镜中的自己协调同步动作来修复裂缝",
        attribute: "execution",
        dc: 5,
        successHint: "动作完美同步，裂缝在缩小",
        failureHint: "节奏对不上，裂缝纹丝不动",
      },
      {
        situation: "理解猫的行为暗示",
        attribute: "empathy",
        dc: 3,
        successHint: "读懂了猫的行为含义，避开了危险区域",
        failureHint: "猫在叫但不知道它想表达什么",
      },
      {
        situation: "分析裂缝扩散的规律，制定修复顺序",
        attribute: "logic",
        dc: 5,
        successHint: "找到了裂缝扩散的弱点，制定出最优修复路线",
        failureHint: "裂缝的行为似乎没有规律，难以预测",
      },
      {
        situation: "即兴利用家中物品创造对抗裂缝的工具",
        attribute: "creativity",
        dc: 4,
        successHint: "找到了意想不到的组合，制造出临时的封印道具",
        failureHint: "东西是凑齐了，但没起作用",
      },
    ],
    difficulty: 3,
    estimatedTurns: 30,
    themes: ["mirror", "home", "cosmic"],
  },
];
