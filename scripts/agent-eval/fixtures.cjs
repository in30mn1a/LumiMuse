/**
 * 加载记忆整理评测样本。
 *
 * 小样本全部手写；规模样本的埋点手写，其余由固定种子生成，不入库以免仓库里多一个大 JSON。
 * 记忆 ID 由 key 哈希得到，送给模型的 ID 看不出哪条是埋点。
 * 所有内容都是虚构的，不得放入真实记忆或聊天。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'memory-review-eval');
const SCALE_SIZE = 800;
const SCALE_SEED = 20261103;

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MEALS = ['早餐', '午饭', '晚饭'];
const FOODS = ['番茄面', '蛋炒饭', '小米粥', '豆腐脑', '素三明治', '米线', '蔬菜沙拉', '玉米', '红薯', '土豆饼', '青菜面', '南瓜粥'];
const MEAL_REMARKS = ['味道还行', '有点凉了', '分量太大没吃完', '比上次好吃', '吃完很困', '是同事推荐的'];
const WEATHERS = ['闷热', '阴冷', '晴得很好', '下了场阵雨', '起了大风'];
const ACTIVITIES = ['在家打扫了厨房', '去图书馆还了书', '去公园走了两圈', '加班到九点', '去超市买了洗衣液', '整理了旧照片', '下楼取了快递', '给阳台的花浇了水'];
const TOPICS = ['火星移民', '远程办公', '手账排版', '二手交易', '极简生活', '城市规划', '宇宙尺度', '方言保护', '纪录片配音', '老街改造', '旧书市集', '播客节目', '桌游规则', '植物养护', '古代建筑'];
const OPINIONS = ['挺有意思', '被夸大了', '值得试试', '和自己关系不大', '需要再想想', '有点理想化'];
const GESTURES = ['跟我分享了一张晚霞照片', '问我今天过得好不好', '说想听我念一段诗', '给我讲了工作里的小事', '让我帮忙起一个文档标题', '说今天有点累', '跟我道了晚安', '让我猜一个谜语'];
const RESPONSES = ['陪用户聊了一会儿', '认真回应了用户', '给用户讲了个笑话', '夸了用户', '提醒用户早点休息', '记下了这件事'];
const HOBBIES = ['逛旧书店', '听播客', '玩桌游', '拍街景', '收集明信片', '逛菜市场', '看纪录片', '养多肉', '骑共享单车', '听白噪音', '看动画片', '拼乐高', '折纸', '练毛笔字', '观鸟', '听相声', '学尤克里里', '做陶艺', '玩数独', '逛博物馆', '看展览', '写短句', '种香草', '做木工', '听老歌'];
const HOBBY_DETAILS = ['通常在周末', '一般安排在下班后', '有空就会去', '说这样能放空', '已经坚持了好几年', '最近才开始'];
const FRIEND_NAMES = ['陈默', '苏晴', '何川', '唐糖', '顾然', '叶舟', '宋雨', '方圆', '钟鸣', '白露', '江帆', '田恬', '罗一', '孟夏', '姜禾', '韩松', '许诺', '夏至', '程橙', '蒋一'];
const FRIEND_FACTS = ['在一家出版社做编辑', '去年去了新西兰读书', '开了一家小花店', '是中学地理老师', '在医院做行政', '刚生了宝宝', '搬去了昆明', '在做独立游戏'];
const EVENTS = ['通过了公司的季度考核', '参加了朋友的婚礼', '完成了一个大项目', '报名了线上课程', '第一次做了公开分享', '做了马拉松赛事志愿者', '去外地出差了一周', '拿到了一笔奖金', '修好了老家的旧电脑', '给爷爷过了八十大寿'];
const EVENT_OUTCOMES = ['事后觉得很值得', '累但开心', '跟我说了很久', '还发了朋友圈', '松了一口气'];
const TRAIT_CONTEXTS = ['开会', '排队', '做计划', '被夸奖', '等人', '收到批评', '旅行前', '买东西', '写文档', '和长辈说话'];
const TRAITS = ['话会变少', '习惯先听别人说', '会反复确认', '容易不好意思', '总是提前准备', '会记下来慢慢想', '喜欢列清单'];

// 模板类别和份额。份额之和 + 埋点数 = SCALE_SIZE，由测试保证。
const FILLER_PLAN = [
  { count: 180, category: '四季日常', memory_kind: 'general', tags: ['饮食'], importance: [0.2, 0.5], build: (pick, date) => {
    const [meal, food, remark] = [pick(MEALS), pick(FOODS), pick(MEAL_REMARKS)];
    return { content: `${date}用户${meal}吃了${food}，${remark}。`, said: `今天${meal}吃了${food}，${remark}。` };
  } },
  { count: 180, category: '四季日常', memory_kind: 'general', tags: ['天气'], importance: [0.2, 0.5], build: (pick, date) => {
    const [weather, activity] = [pick(WEATHERS), pick(ACTIVITIES)];
    return { content: `${date}天气${weather}，用户${activity}。`, said: `今天${weather}，我${activity}。` };
  } },
  { count: 150, category: '话题历史', memory_kind: 'general', tags: ['对话'], importance: [0.3, 0.6], build: (pick, date) => {
    const [topic, opinion] = [pick(TOPICS), pick(OPINIONS)];
    return { content: `${date}用户和我聊到${topic}，用户觉得${opinion}。`, said: `最近在想${topic}的事，感觉${opinion}。` };
  } },
  { count: 110, category: '关系动态', memory_kind: 'relationship_event', tags: ['陪伴方式'], importance: [0.4, 0.7], build: (pick, date) => {
    const [gesture, response] = [pick(GESTURES), pick(RESPONSES)];
    return { content: `${date}用户${gesture}，我${response}。`, said: `今天${gesture.replace('跟我', '').replace('给我', '').replace('让我', '想让你')}。` };
  } },
  { count: 25, category: '偏好习惯', memory_kind: 'user_preference', tags: ['娱乐'], importance: [0.5, 0.8], unique: HOBBIES, build: (pick, date, hobby) => {
    const detail = pick(HOBBY_DETAILS);
    return { content: `用户喜欢${hobby}，${detail}。`, said: `我挺喜欢${hobby}的，${detail}。` };
  } },
  { count: 40, category: '基础信息', memory_kind: 'user_fact', tags: ['家庭'], importance: [0.5, 0.8], build: (pick, date, name, index) => {
    const friend = FRIEND_NAMES[index % FRIEND_NAMES.length];
    const fact = FRIEND_FACTS[index % FRIEND_FACTS.length];
    return { content: `用户的朋友${friend}${fact}。`, said: `我朋友${friend}${fact}。` };
  } },
  { count: 40, category: '重要事件', memory_kind: 'general', tags: ['成就'], importance: [0.5, 0.8], build: (pick, date) => {
    const [event, outcome] = [pick(EVENTS), pick(EVENT_OUTCOMES)];
    return { content: `${date}用户${event}，${outcome}。`, said: `我${event}，${outcome}。` };
  } },
  { count: 22, category: '人格特质', memory_kind: 'general', tags: ['性格'], importance: [0.5, 0.8], build: (pick, date) => {
    const [context, trait] = [pick(TRAIT_CONTEXTS), pick(TRAITS)];
    return { content: `用户在${context}时${trait}。`, said: `我${context}的时候${trait}。` };
  } },
];

function generateFiller() {
  const random = mulberry32(SCALE_SEED);
  const pick = list => list[Math.floor(random() * list.length)];
  const memories = [];
  const seen = new Set();
  FILLER_PLAN.forEach((plan, planIndex) => {
    for (let index = 0; index < plan.count; index += 1) {
      let built;
      let date;
      // 同一模板偶尔会抽到完全相同的组合，重抽，避免填充数据之间出现真重复。
      do {
        const [year, month, day] = [2023 + Math.floor(random() * 3), 1 + Math.floor(random() * 12), 1 + Math.floor(random() * 28)];
        date = { text: `${year}年${month}月${day}日`, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
        built = plan.build(pick, date.text, plan.unique?.[index], index);
      } while (seen.has(built.content));
      seen.add(built.content);
      const [low, high] = plan.importance;
      memories.push({
        key: `f${planIndex}-${index}`,
        category: plan.category,
        content: built.content,
        tags: plan.tags,
        importance: Math.round((low + random() * (high - low)) * 100) / 100,
        memory_kind: plan.memory_kind,
        created_at: date.iso,
        source: [built.said, '嗯，我记下了。'],
      });
    }
  });
  return memories;
}

function opaqueId(sampleName, key) {
  return `mem_${crypto.createHash('sha256').update(`${sampleName}:${key}`).digest('hex').slice(0, 12)}`;
}

function loadSample(name) {
  const rawExpected = readFixture('expected.json')[name];
  if (!rawExpected) throw new Error(`未知样本：${name}`);
  const character = readFixture('character.json');
  const authored = readFixture(name === 'small' ? 'small.json' : 'scale-plants.json').memories;
  const rows = name === 'scale' ? [...authored, ...generateFiller()] : authored;

  const idOf = key => opaqueId(name, key);
  const memories = rows.map(row => ({
    id: idOf(row.key),
    category: row.category,
    content: row.content,
    tags: row.tags,
    importance: row.importance,
    memory_kind: row.memory_kind,
    pinned: row.pinned ? 1 : 0,
    created_at: row.created_at,
    source_messages: [
      { role: 'user', content: row.source[0] },
      { role: 'assistant', content: row.source[1] },
    ],
  }));
  const withIds = plant => ({ ...plant, memory_ids: plant.keys.map(idOf) });
  const expected = {
    conflicts: rawExpected.conflicts.map(withIds),
    duplicates: rawExpected.duplicates.map(withIds),
    misclassified: rawExpected.misclassified.map(plant => ({ ...plant, memory_id: idOf(plant.key) })),
    traps: rawExpected.traps.map(withIds),
    do_not_touch: rawExpected.do_not_touch.map(idOf),
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify({ character, memories, expected })).digest('hex').slice(0, 16);
  return { name, character, memories, expected, hash };
}

module.exports = { loadSample, SCALE_SIZE };
