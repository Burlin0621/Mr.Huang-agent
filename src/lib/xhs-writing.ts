/**
 * 小红书写作工作流：阶段定义与提示词组装（纯函数，便于单测）
 *
 * 六个 block 中前四个为 LLM 阶段（顺序执行、逐段串联产出），
 * 第五个「封面与配图」为配图 prompt 规划阶段（LLM 规划配图 JSON 后只产出中文生图
 * prompt 清单，图片由用户拿 prompt 去外部工具生成，应用内不再调用生图工具，竖版 3:4），
 * 第六个「笔记预览」为纯展示阶段（渲染润色结果与配图 prompt 占位），不发起模型请求。
 * 每个阶段的 system = 社媒运营专家 systemPrompt + 阶段专属指令；
 * user = 用户需求要素 + 前序阶段的产出文本。
 *
 * 写作规则提炼自小红书运营技能（social-media-operator / social-media-optimizer /
 * newmedia-operations / content-hunter）：标题 20 字内带数字悬念、笔记体口语化、
 * emoji 分段排版、互动引导结尾、5-8 个话题标签、违禁词检查与搜索关键词埋点、竖版 3:4 大字封面。
 */

import type { LlmChatMessage } from '@/lib/llm'

import { renderMarkdown } from '@/lib/markdown'

/** 顶部需求输入区的要素 + 作者身份 + 风格字数 */
export interface WritingRequirement {
  /** 主题/关键词（必填） */
  topic: string
  /** 账号定位 */
  positioning: string
  /** 目标读者 */
  audience: string
  /** 写作目标：涨粉/涨互动/种草带货/品牌曝光 */
  goal: string
  /** 风格与字数要求 */
  style: string
  /** 作者职业：为空则按通用社媒运营视角写作 */
  authorRole: string
}

/** 阶段 id（「笔记预览」为纯展示 block，不在此列，由视图直接渲染润色产出与配图） */
export type WritingStageId = 'hotspots' | 'outline' | 'draft' | 'polish' | 'images'

/** 写作目标下拉可选项 */
export const WRITING_GOALS = ['涨粉', '涨互动', '种草带货', '品牌曝光'] as const

/** 账号定位下拉可选项（首项「不指定」由视图用空串 option 提供） */
export const WRITING_POSITIONINGS = [
  '美妆穿搭类',
  '美食探店类',
  '职场成长类',
  '学习干货类',
  '母婴亲子类',
  '生活方式类',
  '健康健身类',
  '情感治愈类',
] as const

/** 目标读者下拉可选项 */
export const WRITING_AUDIENCES = [
  '学生党',
  '大学生',
  '职场新人（0-3 年）',
  '都市白领',
  '宝妈/奶爸',
  '健身爱好者',
  '独居青年',
  '泛兴趣大众',
] as const

/** 风格与字数下拉可选项 */
export const WRITING_STYLES = [
  '种草安利 · 约300字',
  '干货教程 · 约600字',
  '故事分享 · 约500字',
  '避坑测评 · 约400字',
  '情绪共鸣 · 约300字',
] as const

/** 预览卡片作者行 */
export const NOTE_AUTHOR = '社媒运营专家'

/** 单个 LLM 阶段的定义 */
export interface WritingStageDef {
  id: WritingStageId
  /** 卡片标题 */
  title: string
  /** 卡片副标题（一句话说明本阶段做什么） */
  hint: string
  /** 阶段专属指令（拼进 system 与 user 消息） */
  taskPrompt: string
  /** 是否携带工具（仅热点提取阶段在桌面端带联网工具） */
  useTools: boolean
}

/** 四个 LLM 阶段的顺序定义 */
export const WRITING_STAGES: WritingStageDef[] = [
  {
    id: 'hotspots',
    title: '热点与对标笔记提取',
    hint: '检索小红书相关热点话题与爆款笔记，整理可借势角度',
    useTools: true,
    taskPrompt: `请完成「热点与对标笔记提取」阶段：
1. 围绕写作主题，梳理近期（以当前时间为基准）小红书上的相关热点话题、爆款笔记的选题角度、封面/标题套路与评论区高赞情绪；
2. 优先使用 web_search 工具做关键词搜索（可搜 2-4 组不同关键词，如「<主题> 小红书 爆款笔记」「<主题> 热门话题」，并用 recency=oneWeek 限定近期），检索最新信息并注明信息来源；对搜索结果中的重要来源再用 http_get 或 browser_navigate+browser_read 深入阅读；搜索引擎无结果时，基于你的知识给出判断并标注「推断」；
3. 注意控制工具调用总数（建议不超过 6 次），避免耗尽步骤；工具阶段结束后必须直接输出正文，不要只调用工具不输出结论；
4. 对无法核实、属于经验判断的结论，必须在该句末尾标注「（推断）」；
5. 输出一份结构化「热点与对标简报」：分「热门话题 / 高赞笔记选题 / 封面标题套路 / 可借势角度」四小节，每节 3-5 条要点，直接输出简报正文，不要客套话。`,
  },
  {
    id: 'outline',
    title: '选题与标题',
    hint: '给出 5 个候选标题与标签组合，推荐 1 个并输出笔记大纲',
    useTools: false,
    taskPrompt: `请基于上一阶段的热点与对标简报完成「选题与标题」阶段：
1. 给出 5 个候选标题，每个标题须在 20 字以内，至少体现以下要素之一：数字、悬念、身份共鸣、利益点；可适度使用 1-2 个 emoji；每个标题附一句取舍说明（如何在前几个字抓住目标读者）与适配的读者情绪；
2. 每个候选标题附一组话题标签组合（各 5-8 个，混合 1 个大流量标签、2-3 个垂直标签、2-3 个长尾标签）；
3. 从 5 个标题中推荐 1 个并说明理由；
4. 输出完整笔记大纲：钩子开头（3 秒留人）、分点正文（各分点的核心信息与 emoji 排版位置）、互动结尾（提问/投票式钩子）、话题标签；
5. 直接输出内容，不要客套话。`,
  },
  {
    id: 'draft',
    title: '正文撰写',
    hint: '按大纲流式生成口语化笔记体全文',
    useTools: false,
    taskPrompt: `请基于热点简报与大纲完成「正文撰写」阶段，输出可直接发布的完整小红书笔记正文（Markdown）：
1. 开头：黄金 3 秒钩子，用场景/痛点/提问在第一行留住读者；
2. 正文：口语化笔记体，300-800 字，像闺蜜分享一样亲切真实；短句多分段，每段 1-3 行；用 emoji 做小标题与分点排版（每点 1 个 emoji 点缀，不过度堆砌）；
3. 结尾：互动引导，用提问或投票式钩子引导评论，并提示收藏/点赞；
4. 标签：文末另起一行给 5-8 个 # 开头的话题标签（大小流量混合）；
5. 字数与语气遵循写作需求；直接输出笔记正文，不要输出「好的，以下是笔记」之类的开场白。`,
  },
  {
    id: 'polish',
    title: '润色优化',
    hint: '去 AI 味、违禁词与极限词检查、搜索关键词埋点、增强互动钩子',
    useTools: false,
    taskPrompt: `请对上一阶段的笔记全文做「润色优化」改写，直接输出润色后的完整笔记（Markdown）：
1. 去 AI 味：删除模板连接词（首先/其次/总而言之/综上所述）与机器腔，改成有真实感的口语，加入具体场景细节与个人化表达；
2. 违禁词与极限词检查：检查并替换绝对化用语（最、第一、唯一、国家级、100% 等极限词）与夸大承诺、医疗/投资类敏感表述，小红书审核比公众号更严，务必彻底排查；
3. 搜索关键词埋点：把目标读者会搜的关键词自然埋进标题、首段与正文前几行（小红书搜索权重集中在标题与开头），不堆砌不生硬；
4. 增强互动钩子：优化结尾提问，让读者容易用一句话回复；确认标签 5-8 个且与内容强相关；
5. 保留原文结构与核心观点，不新增未核实的事实；只输出润色后的全文，不要输出修改说明。`,
  },
  {
    id: 'images',
    title: '封面与配图',
    hint: '规划首图与内页图的生图 prompt（复制到外部生图工具使用）',
    useTools: false,
    taskPrompt: `请基于润色后的笔记全文与写作需求完成「配图 prompt 规划」，严格按以下 JSON 格式输出（只返回 JSON 本身，不要输出任何解释文字、开场白或代码块标记）：
{"cover":{"prompt":"首图画面描述：竖版 3:4 构图，画面主体 + 明亮吸睛的视觉风格 + 配色，并明确写出需要渲染在图中的笔记主标题文字（20 字以内）与大字号排版要求（醒目居中或上三分之一处）","ratio":"3:4","size":"1152x1536"},"illustrations":[{"prompt":"内页图画面描述：画面主体、风格与配色（与首图风格统一）","ratio":"3:4","size":"960x1280","anchor":"配图应插入位置的小节标题或分点原文","caption":"20字内图注"}]}
字段要求：cover.ratio 固定为 "3:4"（小红书首图竖版），cover.size 用 "1152x1536"；首图 prompt 必须包含要渲染的笔记主标题文字（20 字以内）及大字号醒目排版要求（居中或上三分之一处）——图内大字标题是小红书平台惯例，与公众号封面不同，不要写成纯画面留白；illustrations 必须给 3-5 张（与首图合计 4-6 张），ratio 一律 "3:4"（轮播图统一比例最稳，不要 1:1 或 16:9），size 用 "960x1280"；所有 prompt 一律用中文描述、不含英文；anchor 必须从笔记正文中真实存在的小节标题或分点原文中选取；caption 为 20 字以内的图注。`,
  },
]

/** 把需求要素汇总为可读文本（随每个阶段的 user 消息携带） */
export function buildRequirementText(req: WritingRequirement): string {
  return [
    `- 主题/关键词：${req.topic}`,
    `- 作者职业：${req.authorRole || '未指定'}`,
    `- 账号定位：${req.positioning || '未指定'}`,
    `- 目标读者：${req.audience || '未指定'}`,
    `- 写作目标：${req.goal || '未指定'}`,
    `- 风格与字数：${req.style || '未指定（默认口语化笔记体、300-800 字）'}`,
  ].join('\n')
}

/** 组装阶段 system 消息：智能体 systemPrompt + 阶段专属指令 */
export function buildStageSystemMessage(stage: WritingStageDef, agentSystemPrompt: string): string {
  return `${agentSystemPrompt}\n\n## 当前任务阶段：${stage.title}\n${stage.taskPrompt}`
}

/**
 * 组装阶段 user 消息：写作需求要素 + 前序阶段产出文本 + 本阶段任务提醒。
 * prev 为此前已完成阶段的产出（缺省时给出占位说明）。
 */
export function buildStageUserMessage(
  stage: WritingStageDef,
  req: WritingRequirement,
  prev: Partial<Record<WritingStageId, string>>,
): string {
  const sections: string[] = [`### 写作需求\n${buildRequirementText(req)}`]

  if (stage.id !== 'hotspots') {
    sections.push(
      prev.hotspots
        ? `### 阶段一产出：热点与对标笔记简报\n${prev.hotspots}`
        : '### 阶段一产出：热点与对标笔记简报\n（未提供，请基于写作需求自行判断，推断性结论请标注「推断」）',
    )
  }
  if (stage.id === 'draft' || stage.id === 'polish') {
    sections.push(
      prev.outline
        ? `### 阶段二产出：选题与标题\n${prev.outline}`
        : '### 阶段二产出：选题与标题\n（未提供，请自行拟定标题与大纲后再写作）',
    )
  }
  if (stage.id === 'polish') {
    sections.push(
      prev.draft
        ? `### 阶段三产出：笔记全文\n${prev.draft}`
        : '### 阶段三产出：笔记全文\n（未提供，请直接按写作需求完成一篇笔记后再润色输出）',
    )
  }
  // 作者身份只影响成文的两阶段（撰写/润色）：以职业第一人称视角写作
  if (stage.id === 'draft' || stage.id === 'polish') {
    const personaNotes: string[] = []
    if (req.authorRole) {
      personaNotes.push(
        `请始终以「${req.authorRole}」的职业身份、第一人称经验和口吻写作，观点、案例与细节须符合该身份的亲历视角`,
      )
    }
    if (personaNotes.length > 0) {
      sections.push(`### 作者身份要求\n${personaNotes.join('；')}`)
    }
  }

  sections.push(`### 本阶段任务\n${stage.taskPrompt}`)
  return sections.join('\n\n')
}

/** 从 Markdown 内容中提取首个一级标题（用于预览大标题），无则返回空串 */
export function extractFirstHeading(content: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : ''
}

/** 从笔记全文中提取 # 开头的话题标签（预览标签区展示） */
export function extractHashtags(content: string): string[] {
  const tags = new Set<string>()
  for (const match of content.matchAll(/(^|\s)#[^\s#]+/g)) {
    tags.add(match[0].trim())
  }
  return [...tags].slice(0, 8)
}

/** 组装导出用的完整 Markdown（大标题 + 作者行 + 正文） */
export function buildNoteMarkdown(req: WritingRequirement, content: string): string {
  const title = extractFirstHeading(content) || req.topic
  const body = content.replace(/^#\s+.+\n/, '').trim()
  return `# ${title}\n\n> 作者：${NOTE_AUTHOR}\n\n${body}\n`
}

/* —— 封面与配图（配图 prompt 规划，竖版 3:4）阶段 —— */

/**
 * 配图阶段单条 prompt 条目（存于 store，视图直接渲染为可复制卡片）。
 * 应用内不再生图：用户复制 prompt 去外部工具生成，故无 url/status 等运行时字段。
 */
export interface ImagePromptItem {
  role: 'cover' | 'illustration'
  /** 中文生图画面描述（复制给外部生图工具直接使用） */
  prompt: string
  /** 画面比例：小红书首图与内页统一为竖版 3:4 */
  ratio: string
  /** 参考尺寸"宽x高"（与 ratio 对应） */
  size: string
  /** 配图应插入的小节标题或分点原文（仅内页图） */
  anchor?: string
  /** 一句话图注 */
  caption?: string
}

/** 配图规划的单张图描述（模型 JSON 输出的归一化结果） */
export interface ImagePlanItem {
  prompt: string
  ratio: string
  size: string
  anchor?: string
  caption?: string
}

/** 配图规划结果：1 张首图 + 3-5 张内页图（合计 4-6 张） */
export interface ImagePlan {
  cover: ImagePlanItem
  illustrations: ImagePlanItem[]
}

/** 首图缺省比例与参考尺寸（小红书首图竖版 3:4 标准尺寸） */
export const DEFAULT_COVER_RATIO = '3:4'
export const DEFAULT_COVER_SIZE = '1152x1536'

/** 内页图缺省比例与参考尺寸（轮播图与首图统一 3:4 最稳，尺寸略小） */
export const DEFAULT_ILLUSTRATION_RATIO = '3:4'
export const DEFAULT_ILLUSTRATION_SIZE = '960x1280'

/**
 * 尺寸格式校验：放宽为任一"正整数宽x高"（不同外部生图工具接受的范围不一，不做过严约束）。
 * 仅用于格式判定；parseImagePlan 里因比例固定 3:4，还会额外要求宽高成 3:4 比例，
 * 避免"比例 3:4 + 参考尺寸正方形"这类自相矛盾的归一化结果落到卡片上。
 */
export function isValidImageSize(size: string): boolean {
  return /^\d{2,5}x\d{2,5}$/.test(size)
}

/** 宽高是否成竖版 3:4 比例（小红书首图与内页统一比例，尺寸必须与之一致） */
function isPortraitThreeQuarterSize(size: string): boolean {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (!match) return false
  return Number(match[1]) * 4 === Number(match[2]) * 3
}

/**
 * 从配图规划阶段的模型输出中解析严格 JSON；整体非法返回 null（调用方重试一次后标记失败）。
 * 首图 prompt 必填，ratio 固定归一化为 3:4，size 非法（格式不对或宽高不成 3:4）回退默认值；
 * 内页 prompt 必填、数量不足 3 张视为解析失败（返回 null），多于 5 张截断，
 * 单张 ratio 一律归一化 3:4、size 非法回退默认值，不整体失败。
 */
export function parseImagePlan(raw: string): ImagePlan | null {
  // 兼容模型把 JSON 包在 ```json 代码块或前后闲聊中的情况：截取首个 { 到最后一个 }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const cover = typeof data.cover === 'object' && data.cover !== null ? (data.cover as Record<string, unknown>) : undefined
    const coverPrompt = typeof cover?.prompt === 'string' ? cover.prompt.trim() : ''
    if (!coverPrompt) return null
    // 首图比例固定 3:4：小红书首图无第二比例可选，模型输出其他值也归一化
    const coverRatio = DEFAULT_COVER_RATIO
    const coverSize =
      typeof cover?.size === 'string' && isValidImageSize(cover.size.trim()) && isPortraitThreeQuarterSize(cover.size.trim())
        ? cover.size.trim()
        : DEFAULT_COVER_SIZE
    const rawIllustrations = Array.isArray(data.illustrations) ? data.illustrations : []
    const illustrations: ImagePlanItem[] = []
    // 只取前 5 张：超出部分对一篇笔记信息量有限，截断即可
    for (const item of rawIllustrations.slice(0, 5)) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
      if (!prompt) continue
      illustrations.push({
        prompt,
        // 内页与首图统一 3:4：轮播比例混杂观感差，一律归一化；尺寸不成 3:4 视为非法回退默认
        ratio: DEFAULT_ILLUSTRATION_RATIO,
        size:
          typeof record.size === 'string' && isValidImageSize(record.size.trim()) && isPortraitThreeQuarterSize(record.size.trim())
            ? record.size.trim()
            : DEFAULT_ILLUSTRATION_SIZE,
        anchor: typeof record.anchor === 'string' && record.anchor.trim() ? record.anchor.trim() : undefined,
        caption: typeof record.caption === 'string' && record.caption.trim() ? record.caption.trim() : undefined,
      })
    }
    // 内页不足 3 张说明模型未按 4-6 张的总量要求规划，按解析失败处理让调用方重试
    if (illustrations.length < 3) return null
    return { cover: { prompt: coverPrompt, ratio: coverRatio, size: coverSize }, illustrations }
  } catch {
    return null
  }
}

/** 组装配图规划阶段的请求消息（system = 智能体提示词 + 配图阶段指令；user = 需求 + 润色全文） */
export function buildImagePlanMessages(
  agentSystemPrompt: string,
  req: WritingRequirement,
  polishedContent: string,
): LlmChatMessage[] {
  const stage = WRITING_STAGES.find((item) => item.id === 'images')
  const sections = [
    `### 写作需求\n${buildRequirementText(req)}`,
    polishedContent.trim()
      ? `### 阶段四产出：润色后的笔记全文\n${polishedContent}`
      : '### 阶段四产出：润色后的笔记全文\n（未提供）',
    `### 本阶段任务\n${stage?.taskPrompt ?? ''}`,
  ]
  return [
    {
      role: 'system',
      content: stage
        ? buildStageSystemMessage(stage, agentSystemPrompt)
        : agentSystemPrompt,
    },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

/** prompt 摘要：截取前 maxLen 字，超长补省略号（占位注释里只放摘要，全文在配图卡片里复制） */
function summarizePrompt(prompt: string, maxLen = 50): string {
  return prompt.length > maxLen ? `${prompt.slice(0, maxLen)}…` : prompt
}

/**
 * 内页图定位结果：number 为全局编号（见 locateIllustrationPlaceholders），
 * lineIndex 为命中的行下标（-1 表示 anchor 未命中、兜底文末）。
 */
interface IllustrationPlacement {
  item: ImagePromptItem
  number: number
  lineIndex: number
}

/**
 * 定位每张内页图在正文中的插入点（export/preview 两种占位模式共用同一份定位结果，
 * 保证「预览里看到的标记位置」与「导出 md 里的注释位置」严格一致）。
 * 小红书特性：笔记多为 emoji 分点、无小节标题，anchor 匹配标题行或包含 anchor
 * 原文的正文行均可（不退化成只匹配标题）；每个行只挂一张，未命中的按顺序兜底到文末。
 * 编号 = images 数组序号 + 1（首图固定第 1 张、内页依次 2、3、4…，即生成顺序），
 * 展示层不单独存编号，卡片徽标与两种占位符都由这里统一推导。
 */
function locateIllustrationPlaceholders(content: string, images: ImagePromptItem[]): IllustrationPlacement[] {
  const lines = content.split('\n')
  /** 已被占用的行下标（每行只挂一张内页图） */
  const usedLines = new Set<number>()
  const placements: IllustrationPlacement[] = []
  images.forEach((item, index) => {
    if (item.role !== 'illustration') return
    const anchor = (item.anchor ?? '').trim()
    let lineIndex = -1
    if (anchor) {
      lineIndex = lines.findIndex((line, i) => {
        if (usedLines.has(i)) return false
        // 标题行或包含 anchor 原文的正文行均可定位（小红书笔记常无小节标题）
        if (/^#{1,6}\s/.test(line)) {
          const headingText = line.replace(/^#{1,6}\s*/, '').trim()
          return headingText === anchor || headingText.includes(anchor)
        }
        return line.includes(anchor)
      })
    }
    if (lineIndex >= 0) usedLines.add(lineIndex)
    placements.push({ item, number: index + 1, lineIndex })
  })
  return placements
}

/**
 * 按定位结果把占位行写入正文行流：命中的插在该行之后，未命中的按顺序兜底追加文末。
 * buildLine 由两种模式各自传入，只负责把单条定位结果渲染成占位文本。
 */
function applyPlaceholders(
  content: string,
  placements: IllustrationPlacement[],
  buildLine: (placement: IllustrationPlacement) => string,
): string {
  const lines = content.split('\n')
  /** 已定位内页图的插入点：行下标 → 待插入的占位行 */
  const insertions = new Map<number, string[]>()
  /** anchor 未能定位的内页图占位行，按顺序兜底追加到文末 */
  const fallback: string[] = []
  for (const placement of placements) {
    const line = buildLine(placement)
    if (placement.lineIndex >= 0) {
      const inserted = insertions.get(placement.lineIndex) ?? []
      inserted.push('', line)
      insertions.set(placement.lineIndex, inserted)
    } else {
      fallback.push(line)
    }
  }
  const output: string[] = []
  lines.forEach((line, index) => {
    output.push(line)
    const inserted = insertions.get(index)
    if (inserted) output.push(...inserted)
  })
  if (fallback.length > 0) {
    output.push('', ...fallback)
  }
  return output.join('\n')
}

/**
 * 生成「带占位符版 markdown」（export 模式，复制笔记/导出 .md 用）：
 * 内页图按 anchor 定位在对应行后插 HTML 注释占位（渲染不可见，仅作导出 md 里的定位线索），
 * anchor 找不到时按顺序兜底追加到文末；首图在文首插注释（includeCover 控制）。
 * 占位符含全局编号（图1=首图，内页依次编号），与配图卡片、预览标记一一对应，
 * 用户按编号生图后照注释插回正文。导出 md 不含图片 URL，无死链或空 ![]() 语法。
 */
export function buildNoteWithPlaceholders(
  content: string,
  images: ImagePromptItem[],
  includeCover: boolean,
): string {
  const coverIndex = images.findIndex((img) => img.role === 'cover')
  const cover = includeCover && coverIndex >= 0 ? images[coverIndex] : undefined
  const body = applyPlaceholders(
    content,
    locateIllustrationPlaceholders(content, images),
    ({ item, number }) =>
      `<!-- 图${number} 内页图（${item.ratio}${item.caption ? ` · 图注：${item.caption}` : ''}）：prompt：${summarizePrompt(item.prompt)} -->`,
  )
  if (cover) {
    return `<!-- 图${coverIndex + 1} 首图（${cover.ratio}）：${summarizePrompt(cover.prompt)} -->\n\n${body}`
  }
  return body
}

/**
 * 生成「预览正文 markdown」（preview 模式，笔记预览的 RichText 渲染用）：
 * 占位行用可见的 blockquote 提示块呈现，用户在预览正文里能直观看到每张图该插在哪。
 * 首图不进预览正文（预览顶部另有首图占位框）；anchor 未命中的兜底文末并加注说明。
 * 与 export 模式共用 locateIllustrationPlaceholders，标记位置严格一致。
 */
export function buildNotePreviewMarkdown(content: string, images: ImagePromptItem[]): string {
  return applyPlaceholders(
    content,
    locateIllustrationPlaceholders(content, images),
    ({ item, number, lineIndex }) => {
      const base = `> 📷 此处插入 图${number}（内页 · ${item.ratio}）${item.caption ? `｜图注：${item.caption}` : ''}`
      return lineIndex >= 0 ? base : `${base}（未定位到对应内容，建议插在文末）`
    },
  )
}

/* —— HTML 网页预览/导出 —— */

/** HTML 转义：标题/作者等用户文本要进 <title> 与标签体，防注入（正文走 renderMarkdown 已消毒） */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 生成「笔记 HTML 网页」：完整独立 HTML 文档（视图「在浏览器打开」「导出 .html」用）。
 * - 样式全部内联在文档 <style>，不引用任何外部资源（img/src/href 均无外链），离线可开；
 * - 排版仿小红书笔记：窄容器约 420px 居中、正文 15px、标题 18px 加粗、作者行小号灰字；
 * - 正文复用 preview 模式 markdown（📷 内页占位行渲染成 blockquote，再样式化成
 *   虚线居中的显眼插图占位块），经 renderMarkdown（markdown-it + DOMPurify）消毒；
 * - 文首放首图占位框（图1 · 3:4 · 请生成后上传）。
 */
export function buildNoteHtml(req: WritingRequirement, content: string, images: ImagePromptItem[]): string {
  const title = escapeHtml(extractFirstHeading(content) || req.topic)
  const author = escapeHtml(NOTE_AUTHOR)
  const coverIndex = images.findIndex((img) => img.role === 'cover')
  const cover = coverIndex >= 0 ? images[coverIndex] : undefined
  const coverSlot = cover
    ? `  <div class="img-slot">图${coverIndex + 1} · 首图占位 · ${escapeHtml(cover.ratio)} · 请生成后上传</div>\n`
    : ''
  const bodyHtml = renderMarkdown(buildNotePreviewMarkdown(content, images))
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; background: #f2f2f2; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .container { max-width: 420px; margin: 0 auto; padding: 24px 16px 40px; background: #ffffff; min-height: 100vh; box-sizing: border-box; }
  h1.title { margin: 0 0 8px; font-size: 18px; line-height: 1.5; font-weight: 700; color: #1c1917; }
  p.author { margin: 0 0 16px; font-size: 13px; color: #8c8c8c; }
  .img-slot { margin: 0 0 16px; padding: 48px 16px; border: 1px dashed #c9c9c9; border-radius: 8px; text-align: center; font-size: 14px; color: #8c8c8c; }
  .content { font-size: 15px; line-height: 1.8; color: #3f3f3f; overflow-wrap: anywhere; }
  .content strong { font-weight: 700; color: #1c1917; }
  .content blockquote { margin: 1.2em 0; padding: 20px 14px; border: 1px dashed #c9c9c9; border-radius: 8px; text-align: center; color: #8c8c8c; font-size: 13px; background: #fafafa; }
  .content blockquote p { margin: 0; }
</style>
</head>
<body>
<div class="container">
${coverSlot}  <h1 class="title">${title}</h1>
  <p class="author">作者：${author}</p>
  <div class="content">
${bodyHtml}
  </div>
</div>
</body>
</html>
`
}
