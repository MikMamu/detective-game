// 骨架抽取：素材库 + 种子随机。逻辑结构在这里锁定，LLM 只负责填血肉。

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

export const GENRES = [
  { id: 'mansion', name: '民国宅院', setting: '民国十二年深秋，江南富商宅邸，灵堂已设，宾客未散' },
  { id: 'lodge', name: '雪夜山庄', setting: '暴雪封山，山中私人山庄，众人被困，通讯断绝' },
  { id: 'cyber', name: '赛博都市', setting: '2077年夜城，霓虹与酸雨，巨型企业顶层公寓发生命案' },
  { id: 'cruise', name: '海上游轮', setting: '远洋豪华游轮，命案发生在公海，靠岸前必须破案' },
  { id: 'academy', name: '魔法学院', setting: '古老魔法学院，期末夜宴后，院长倒毙于封闭的塔楼' },
  { id: 'oasis', name: '沙漠驿站', setting: '大漠孤城，商队驿站，沙暴将所有人困在土楼之中' },
];

export const TEMPLATES = [
  { id: 'poison', name: '毒杀', death_method: '中毒身亡' },
  { id: 'blade', name: '刀伤', death_method: '利刃刺中要害' },
  { id: 'locked', name: '密室', death_method: '密室中离奇死亡' },
  { id: 'accident', name: '伪装意外', death_method: '表面看是意外身亡' },
];

export const ARCHETYPES = {
  killer: ['温文尔雅的医生', '深藏不露的合伙人', '被轻视的家庭教师', '忠厚老实的园丁', '优雅干练的女秘书'],
  insider: ['忠心的老管家', '爱打听的厨娘', '胆小的学徒', '退隐的账房先生'],
  liar: ['娇蛮的二小姐', '虚荣的歌女', '欠债的赌徒', '顺手牵羊的小厮'],
  redherring: ['暴躁的大少爷', '与死者结仇的生意对手', '被冷落的女婿', '来路不明的旧友'],
  bystander: ['怯懦的丫鬟', '新来的侍者', '送货的小贩', '巡夜的更夫'],
};

export const MOTIVE_POOL = ['钱', '情', '仇', '不可告人的秘密'];

export const DIFFICULTY = {
  easy: { name: '简单', liars: 2, chainLength: 2 },
  normal: { name: '普通', liars: 3, chainLength: 3 },
  hard: { name: '困难', liars: 5, chainLength: 4 },
};

export function pickSkeleton({ genre, difficulty = 'normal', seed } = {}) {
  const s = seed == null ? Date.now() : Number(seed);
  const rnd = mulberry32(s >>> 0);
  const g = genre ? GENRES.find((x) => x.id === genre) || GENRES[0] : pick(GENRES, rnd);
  const tpl = pick(TEMPLATES, rnd);
  const diff = DIFFICULTY[difficulty] || DIFFICULTY.normal;

  const slots = ['killer', 'insider', 'liar', 'redherring', 'bystander'].map((slot) => ({
    slot,
    archetype: pick(ARCHETYPES[slot], rnd),
  }));

  return {
    seed: s >>> 0,
    genre: g,
    template: tpl,
    difficulty: diff.name,
    liar_count: diff.liars,
    evidence_chain_length: diff.chainLength,
    slots,
    motive_pool: MOTIVE_POOL,
  };
}
