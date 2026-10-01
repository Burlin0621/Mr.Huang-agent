/**
 * 公众号写作工作流：阶段定义与提示词组装（纯函数，便于单测）
 *
 * 六个 block 中前四个为 LLM 阶段（顺序执行、逐段串联产出），
 * 第五个「封面与插图」为配图 prompt 规划阶段（LLM 规划配图 JSON 后只产出中文生图
 * prompt 清单，图片由用户拿 prompt 去外部工具生成，应用内不再调用生图工具），
 * 第六个「文章预览」为纯展示阶段（渲染润色结果与配图 prompt 占位），不发起模型请求。
 * 每个阶段的 system = 社媒运营专家 systemPrompt + 阶段专属指令；
 * user = 用户需求要素 + 前序阶段的产出文本。
 */

import type { LlmChatMessage } from '@/lib/llm'

import { renderMarkdown } from '@/lib/markdown'

/** 顶部需求输入区的四要素 + 作者身份 + 风格字数 */
export interface WritingRequirement {
  /** 主题/关键词（必填） */
  topic: string
  /** 账号定位 */
  positioning: string
  /** 目标读者 */
  audience: string
  /** 写作目标：涨粉/带货/品牌/互动 */
  goal: string
  /** 风格与字数要求 */
  style: string
  /** 公众号名称（同时用作预览/导出的作者行，未填回退 ARTICLE_AUTHOR） */
  mpName: string
  /** 公众号简介：约束文章调性须符合简介定位 */
  mpBio: string
  /** 作者职业：为空则按通用社媒运营视角写作 */
  authorRole: string
}

/** 阶段 id（「文章预览」为纯展示 block，不在此列，由视图直接渲染润色产出与配图） */
export type WritingStageId = 'hotspots' | 'outline' | 'draft' | 'polish' | 'images'

/** 写作目标下拉可选项 */
export const WRITING_GOALS = ['涨粉', '带货', '品牌', '互动'] as const

/** 账号定位下拉可选项（首项「不指定」由视图用空串 option 提供） */
export const WRITING_POSITIONINGS = [
  '职场成长类',
  '科技/AI 类',
  '情感生活类',
  '财经商业类',
  '教育学习类',
  '健康养生类',
  '母婴亲子类',
  '自媒体运营类',
] as const

/** 目标读者下拉可选项 */
export const WRITING_AUDIENCES = [
  '职场新人（0-3 年）',
  '资深职场人（5-10 年）',
  '中层管理者',
  '创业者/自由职业',
  '大学生',
  '程序员/技术人',
  '宝妈/奶爸',
  '泛兴趣大众',
] as const

/** 风格与字数下拉可选项 */
export const WRITING_STYLES = [
  '口语化俏皮 · 约1500字',
  '干货硬核 · 约2000字',
  '故事叙事 · 约1800字',
  '犀利吐槽 · 约1200字',
  '温暖治愈 · 约1500字',
  '深度长文 · 约3000字',
] as const

/** 预览卡片作者行 */
export const ARTICLE_AUTHOR = '社媒运营专家'

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
    title: '热点信息提取',
    hint: '检索并整理与主题相关的热点、爆款案例与平台动向',
    useTools: true,
    taskPrompt: `请完成「热点信息提取」阶段：
1. 围绕写作主题，梳理近期（以当前时间为基准）相关的热点事件、话题争议、平台流量动向与同类爆款公众号文章的选题角度；
2. 优先使用 web_search 工具做关键词搜索（可搜 2-4 组不同关键词，如「<主题> 最新动态」「<主题> 公众号爆款」，并用 recency=oneWeek 限定近期），检索最新信息并注明信息来源；对搜索结果中的重要来源再用 http_get 或 browser_navigate+browser_read 深入阅读；搜索引擎无结果时，基于你的知识给出判断并标注「推断」；
3. 注意控制工具调用总数（建议不超过 6 次），避免耗尽步骤；工具阶段结束后必须直接输出正文，不要只调用工具不输出结论；
4. 对无法核实、属于经验判断的结论，必须在该句末尾标注「（推断）」；
5. 输出一份结构化「热点简报」：分「热点事件 / 用户情绪 / 竞品选题 / 可借势角度」四小节，每节 3-5 条要点，直接输出简报正文，不要客套话。`,
  },
  {
    id: 'outline',
    title: '选题与大纲',
    hint: '给出 3 个候选标题与完整文章大纲',
    useTools: false,
    taskPrompt: `请基于上一阶段的热点简报完成「选题与大纲」阶段：
1. 给出 3 个候选标题，每个标题附一句取舍说明：重点解释前 13 个字如何抓眼球（悬念、数字、身份共鸣、利益点等），以及该标题适配的读者情绪；
2. 从 3 个标题中推荐 1 个并说明理由；
3. 输出完整文章大纲：开头钩子、各小节标题与核心论点（含要用到的热点素材）、金句/案例位、结尾 CTA；
4. 直接输出内容，不要客套话。`,
  },
  {
    id: 'draft',
    title: '正文撰写',
    hint: '按大纲流式生成公众号全文',
    useTools: false,
    taskPrompt: `请基于热点简报与大纲完成「正文撰写」阶段，输出可直接发布的完整文章正文（Markdown）：
1. 开头：黄金 3 秒钩子，用场景/冲突/提问在前两行留住读者；
2. 正文：金字塔结构，先给核心结论再展开论据，热点素材与案例自然嵌入；
3. 格式（Markdown 硬性要求）：小节标题必须用 ## 二级标题语法（不要把「一、二、三」写成普通段落，标题文案保持口语化）；每节的核心结论句或金句用 **加粗**（全篇 3-6 处，不要滥用）；并列要点用 Markdown 列表语法（- 开头），让下游预览与 HTML 导出有排版层次；
4. 结尾：给出明确的 CTA（点赞/在看/留言/关注，按写作目标选择）；
5. 字数与语气遵循写作需求；直接输出文章正文，不要输出「好的，以下是文章」之类的开场白。`,
  },
  {
    id: 'polish',
    title: '润色去 AI 味',
    hint: '口语化改写、去模板连接词、排查违禁词',
    useTools: false,
    taskPrompt: `请对上一阶段的正文全文做「润色去 AI 味」改写，直接输出润色后的完整文章（Markdown）：
1. 口语化：书面腔改成人话，加入具体场景细节，长短句交错，删除「首先/其次/总而言之/综上所述」等模板连接词；
2. 保留原文结构与核心观点，不新增未核实的事实；## 小节标题、**加粗**、列表等 Markdown 格式结构必须原样保留，不得拍平成纯文本段落；
3. 违禁词排查：检查并替换绝对化用语（最、第一、国家级等）与夸大承诺类表述；
4. 只输出润色后的全文，不要输出修改说明。`,
  },
  {
    id: 'images',
    title: '封面与插图',
    hint: '规划封面与插图的生图 prompt（复制到外部生图工具使用）',
    useTools: false,
    taskPrompt: `请基于润色后的文章全文与写作需求完成「配图 prompt 规划」，严格按以下 JSON 格式输出（只返回 JSON 本身，不要输出任何解释文字、开场白或代码块标记）：
{"cover":{"prompt":"封面画面描述：画面主体 + 视觉风格 + 配色 + 构图布局，构图注明画面一侧留白、便于后期叠加标题文字（不要要求图中渲染文字）","ratio":"2.35:1","size":"1080x460"},"illustrations":[{"prompt":"插图画面描述：画面主体、风格与配色","ratio":"16:9","size":"1280x720","anchor":"插图应插入位置的小节标题原文","caption":"20字内图注"}]}
字段要求：cover.ratio 固定为 "2.35:1"（公众号头条封面），cover.size 用 "1080x460"（同比例更大可接受，如 900x383 以上）；illustrations 必须给 3-5 张（与封面合计 4-6 张），ratio 只能从 "16:9"、"3:2"、"1:1" 中选择（对应 size 参考 "1280x720"、"1440x960"、"1080x1080"，避免竖长图）；所有 prompt 一律用中文描述、不含英文；anchor 必须从文章中真实存在的小节标题原文中选取；caption 为 20 字以内的图注。`,
  },
]

/** 把需求要素汇总为可读文本（随每个阶段的 user 消息携带） */
export function buildRequirementText(req: WritingRequirement): string {
  return [
    `- 主题/关键词：${req.topic}`,
    `- 公众号名称：${req.mpName || '未指定'}`,
    `- 公众号简介：${req.mpBio || '未指定'}`,
    `- 作者职业：${req.authorRole || '未指定'}`,
    `- 账号定位：${req.positioning || '未指定'}`,
    `- 目标读者：${req.audience || '未指定'}`,
    `- 写作目标：${req.goal || '未指定'}`,
    `- 风格与字数：${req.style || '未指定（默认口语化、1500-2500 字）'}`,
  ].join('\n')
}

/** 组装阶段 system 消息：智能体 systemPrompt + 阶段专属指令 */
export function buildStageSystemMessage(stage: WritingStageDef, agentSystemPrompt: string): string {
  return `${agentSystemPrompt}\n\n## 当前任务阶段：${stage.title}\n${stage.taskPrompt}`
}

/**
 * 组装阶段 user 消息：写作需求四要素 + 前序阶段产出文本 + 本阶段任务提醒。
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
        ? `### 阶段一产出：热点信息简报\n${prev.hotspots}`
        : '### 阶段一产出：热点信息简报\n（未提供，请基于写作需求自行判断，推断性结论请标注「推断」）',
    )
  }
  if (stage.id === 'draft' || stage.id === 'polish') {
    sections.push(
      prev.outline
        ? `### 阶段二产出：选题与大纲\n${prev.outline}`
        : '### 阶段二产出：选题与大纲\n（未提供，请自行拟定标题与大纲后再写作）',
    )
  }
  if (stage.id === 'polish') {
    sections.push(
      prev.draft
        ? `### 阶段三产出：正文全文\n${prev.draft}`
        : '### 阶段三产出：正文全文\n（未提供，请直接按写作需求完成一篇全文后再润色输出）',
    )
  }
  // 作者身份只影响成文的两阶段（撰写/润色）：以职业第一人称视角写作，调性符合公众号简介定位
  if (stage.id === 'draft' || stage.id === 'polish') {
    const personaNotes: string[] = []
    if (req.authorRole) {
      personaNotes.push(
        `请始终以「${req.authorRole}」的职业身份、第一人称经验和口吻写作，观点、案例与细节须符合该身份的亲历视角`,
      )
    }
    if (req.mpName || req.mpBio) {
      personaNotes.push(
        `文章将发布${req.mpName ? `于公众号「${req.mpName}」` : ''}${req.mpBio ? `（简介：${req.mpBio}）` : ''}，行文风格与选题口径须符合该简介的定位`,
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

/** 组装导出用的完整 Markdown（大标题 + 作者行 + 正文；作者行优先用公众号名称） */
export function buildArticleMarkdown(req: WritingRequirement, content: string): string {
  const title = extractFirstHeading(content) || req.topic
  const body = content.replace(/^#\s+.+\n/, '').trim()
  const author = req.mpName || ARTICLE_AUTHOR
  return `# ${title}\n\n> 作者：${author}\n\n${body}\n`
}

/* —— 封面与插图（配图 prompt 规划）阶段 —— */

/**
 * 配图阶段单条 prompt 条目（存于 store，视图直接渲染为可复制卡片）。
 * 应用内不再生图：用户复制 prompt 去外部工具生成，故无 url/status 等运行时字段。
 */
export interface ImagePromptItem {
  role: 'cover' | 'illustration'
  /** 中文生图画面描述（复制给外部生图工具直接使用） */
  prompt: string
  /** 画面比例：封面 2.35:1，插图 16:9 / 3:2 / 1:1 */
  ratio: string
  /** 参考尺寸"宽x高"（与 ratio 对应） */
  size: string
  /** 插图应插入的小节标题原文（仅插图） */
  anchor?: string
  /** 一句话图注 */
  caption?: string
  /** 用户上传的成图 dataURL（仅应用内预览与导出 HTML 渲染用，不参与 prompt 复制与主持久化 key） */
  dataUrl?: string
}

/** 配图规划的单张图描述（模型 JSON 输出的归一化结果） */
export interface ImagePlanItem {
  prompt: string
  ratio: string
  size: string
  anchor?: string
  caption?: string
}

/** 配图规划结果：1 张封面 + 3-5 张插图（合计 4-6 张） */
export interface ImagePlan {
  cover: ImagePlanItem
  illustrations: ImagePlanItem[]
}

/** 封面缺省比例与参考尺寸（公众号头条封面官方最小 900×383，取同比例更大值） */
export const DEFAULT_COVER_RATIO = '2.35:1'
export const DEFAULT_COVER_SIZE = '1080x460'

/** 插图缺省比例与参考尺寸（横版 16:9 为主，避免竖长图） */
export const DEFAULT_ILLUSTRATION_RATIO = '16:9'
export const DEFAULT_ILLUSTRATION_SIZE = '1280x720'

/** 插图可选比例白名单（与阶段 taskPrompt 中给出的推荐值保持一致） */
const ILLUSTRATION_RATIO_VALUES = ['16:9', '3:2', '1:1']

/** 尺寸格式校验：放宽为任一"正整数宽x高"（不同外部生图工具接受的范围不一，不做过严约束） */
export function isValidImageSize(size: string): boolean {
  return /^\d{2,5}x\d{2,5}$/.test(size)
}

/** 插图比例校验：只能从推荐值 16:9 / 3:2 / 1:1 中选 */
function isValidIllustrationRatio(ratio: string): boolean {
  return ILLUSTRATION_RATIO_VALUES.includes(ratio)
}

/**
 * 从配图规划阶段的模型输出中解析严格 JSON；整体非法返回 null（调用方重试一次后标记失败）。
 * 封面 prompt 必填，ratio/size 缺省或非法时回退默认值；
 * 插图 prompt 必填、数量不足 3 张视为解析失败（返回 null），多于 5 张截断，
 * 单张 ratio/size 非法时回退默认值，不整体失败。
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
    // 封面比例固定为公众号头条封面 2.35:1，模型输出其他值也归一化为该值
    const coverRatio = DEFAULT_COVER_RATIO
    const coverSize =
      typeof cover?.size === 'string' && isValidImageSize(cover.size.trim())
        ? cover.size.trim()
        : DEFAULT_COVER_SIZE
    const rawIllustrations = Array.isArray(data.illustrations) ? data.illustrations : []
    const illustrations: ImagePlanItem[] = []
    // 只取前 5 张：超出部分对一篇文章信息量有限，截断即可
    for (const item of rawIllustrations.slice(0, 5)) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
      if (!prompt) continue
      illustrations.push({
        prompt,
        ratio:
          typeof record.ratio === 'string' && isValidIllustrationRatio(record.ratio.trim())
            ? record.ratio.trim()
            : DEFAULT_ILLUSTRATION_RATIO,
        size:
          typeof record.size === 'string' && isValidImageSize(record.size.trim())
            ? record.size.trim()
            : DEFAULT_ILLUSTRATION_SIZE,
        anchor: typeof record.anchor === 'string' && record.anchor.trim() ? record.anchor.trim() : undefined,
        caption: typeof record.caption === 'string' && record.caption.trim() ? record.caption.trim() : undefined,
      })
    }
    // 插图不足 3 张说明模型未按 4-6 张的总量要求规划，按解析失败处理让调用方重试
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
      ? `### 阶段四产出：润色后的文章全文\n${polishedContent}`
      : '### 阶段四产出：润色后的文章全文\n（未提供）',
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
 * 插图定位结果：number 为全局编号（见 locateIllustrationPlaceholders），
 * lineIndex 为命中的小节标题行下标（-1 表示 anchor 未命中、兜底文末）。
 */
interface IllustrationPlacement {
  item: ImagePromptItem
  number: number
  lineIndex: number
}

/**
 * 定位每张插图在正文中的插入点（export/preview 两种占位模式共用同一份定位结果，
 * 保证「预览里看到的标记位置」与「导出 md 里的注释位置」严格一致）：
 * 按 anchor 匹配小节标题（每个标题行只挂一张，避免同节堆叠），未命中的按顺序兜底到文末。
 * 编号 = images 数组序号 + 1（封面固定第 1 张、插图依次 2、3、4…，即生成顺序），
 * 展示层不单独存编号，卡片徽标与两种占位符都由这里统一推导。
 */
function locateIllustrationPlaceholders(content: string, images: ImagePromptItem[]): IllustrationPlacement[] {
  const lines = content.split('\n')
  /** 已被占用的标题行下标（每个小节标题只挂一张插图） */
  const usedHeadingLines = new Set<number>()
  const placements: IllustrationPlacement[] = []
  images.forEach((item, index) => {
    if (item.role !== 'illustration') return
    const anchor = (item.anchor ?? '').trim()
    let lineIndex = -1
    if (anchor) {
      lineIndex = lines.findIndex((line, i) => {
        if (!/^#{1,6}\s/.test(line) || usedHeadingLines.has(i)) return false
        const headingText = line.replace(/^#{1,6}\s*/, '').trim()
        return headingText === anchor || headingText.includes(anchor)
      })
    }
    if (lineIndex >= 0) usedHeadingLines.add(lineIndex)
    placements.push({ item, number: index + 1, lineIndex })
  })
  return placements
}

/**
 * 按定位结果把占位行写入正文行流：命中的插在标题行之后，未命中的按顺序兜底追加文末。
 * buildLine 由两种模式各自传入，只负责把单条定位结果渲染成占位文本。
 */
function applyPlaceholders(
  content: string,
  placements: IllustrationPlacement[],
  buildLine: (placement: IllustrationPlacement) => string,
): string {
  const lines = content.split('\n')
  /** 已定位插图的插入点：标题行下标 → 待插入的占位行 */
  const insertions = new Map<number, string[]>()
  /** anchor 未能定位的插图占位行，按顺序兜底追加到文末 */
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
 * 生成「带占位符版 markdown」（export 模式，复制全文/导出 .md 用）：
 * 插图按 anchor 定位在标题行后插 HTML 注释占位（渲染不可见，仅作导出 md 里的定位线索），
 * anchor 找不到时按顺序兜底追加到文末；封面在文首插注释（includeCover 控制）。
 * 占位符含全局编号（图1=封面，插图依次编号），与配图卡片、预览标记一一对应，
 * 用户按编号生图后照注释插回正文。导出 md 不含图片 URL，无死链或空 ![]() 语法。
 */
export function buildArticleWithPlaceholders(
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
      `<!-- 图${number} 插入处（插图 · ${item.ratio}${item.caption ? ` · 图注：${item.caption}` : ''}）：prompt：${summarizePrompt(item.prompt)} -->`,
  )
  if (cover) {
    return `<!-- 图${coverIndex + 1} 封面图（${cover.ratio}）：${summarizePrompt(cover.prompt)} -->\n\n${body}`
  }
  return body
}

/**
 * 生成「预览正文 markdown」（preview 模式，文章预览的 RichText 与导出 HTML 正文共用）：
 * 插图条目已上传成图（dataUrl）时输出 markdown 真图，否则用可见的 blockquote 提示块呈现，
 * 用户在预览正文里能直观看到每张图该插在哪 / 是什么样。
 * 封面不进预览正文（预览顶部另有封面位）；anchor 未命中的兜底文末并加注说明（仅占位模式）。
 * 与 export 模式共用 locateIllustrationPlaceholders，标记位置严格一致。
 * data:image URI 放行链路：markdown-it GOOD_DATA_RE（gif/png/jpeg/webp）+ DOMPurify img 白名单，见 image-upload.ts。
 */
export function buildArticlePreviewMarkdown(content: string, images: ImagePromptItem[]): string {
  return applyPlaceholders(
    content,
    locateIllustrationPlaceholders(content, images),
    ({ item, number, lineIndex }) => {
      // 已上传成图：直接渲染 markdown 真图（alt 中不安全的中括号替换为空格，位置与占位标记一致）
      if (item.dataUrl) {
        const alt = `图${number}${item.caption ? `｜${item.caption}` : ''}`.replace(/[[\]]/g, ' ')
        return `![${alt}](${item.dataUrl})`
      }
      const base = `> 📷 此处插入 图${number}（插图 · ${item.ratio}）${item.caption ? `｜图注：${item.caption}` : ''}`
      return lineIndex >= 0 ? base : `${base}（未定位到小节，建议插在文末）`
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
 * 生成「文章 HTML 网页」：完整独立 HTML 文档（视图「在浏览器打开」「导出 .html」用）。
 * - 样式全部内联在文档 <style>，不引用任何外部资源（img/src/href 均无外链），离线可开；
 * - 排版仿公众号：容器 677px 居中、正文 16px/1.8、大标题 22px、作者行小号灰字；
 *   h2/h3/加粗/hr/列表样式与应用内白底预览一致，文章一带 Markdown 结构即有层次；
 * - 正文复用 preview 模式 markdown（插图已上传成图时渲染真图，未上传渲染为 blockquote
 *   占位块），经 renderMarkdown（markdown-it + DOMPurify）消毒；
 * - 文首封面：已上传成图渲染 <img> 真图，未上传放占位框（图N · 封面图 · 2.35:1 · 请生成后上传）。
 */
/**
 * 公众号正文内联样式表（键 = 标签名，值 = style 属性字符串）：
 * 公众号编辑器粘贴时只认内联 style，不认 <style>/<class>，因此富文本复制
 * （buildArticleRichHtml）把每个元素都打上内联样式，保证"预览即所得"。
 * 颜色约定（仿真白底恒定，不随应用主题翻转）：正文 #3f3f3f、标题 #1c1917、
 * 品牌橙锚点 #ff6a00（h2 左竖条 / 引用竖线）、强调深橙 #c95400（白底可读）。
 */
const MP_INLINE_STYLES: Record<string, string> = {
  p: 'margin: 0 0 16px; font-size: 15px; line-height: 1.9; letter-spacing: 0.5px; color: #3f3f3f; text-align: justify;',
  h2: 'margin: 32px 0 16px; padding-left: 10px; font-size: 17px; line-height: 1.5; font-weight: 700; color: #1c1917; border-left: 4px solid #ff6a00;',
  h3: 'margin: 24px 0 12px; font-size: 16px; line-height: 1.5; font-weight: 700; color: #1c1917;',
  strong: 'font-weight: 700; color: #c95400;',
  em: 'font-style: normal; color: #c95400;',
  img: 'display: block; max-width: 100%; height: auto; border-radius: 8px;',
  ul: 'margin: 0 0 16px; padding-left: 1.4em; color: #3f3f3f;',
  ol: 'margin: 0 0 16px; padding-left: 1.4em; color: #3f3f3f;',
  li: 'margin: 6px 0; font-size: 15px; line-height: 1.9; letter-spacing: 0.5px; text-align: justify;',
  blockquote:
    'margin: 0 0 16px; padding: 12px 16px; border-left: 3px solid #ff6a00; background: #fff7f0; border-radius: 0 8px 8px 0; font-size: 14px; line-height: 1.8; color: #57534e;',
  hr: 'width: 60px; margin: 28px auto; border: none; border-top: 1px solid #e4e1dc;',
  a: 'color: #e85f00;',
  code: 'padding: 2px 5px; background: #f5f3f0; border-radius: 4px; font-size: 13px; color: #c95400;',
  pre: 'margin: 0 0 16px; padding: 12px 16px; background: #f5f3f0; border-radius: 8px; overflow-x: auto;',
}

/**
 * 把 MP_INLINE_STYLES 打到 markdown 渲染出的 HTML 开标签上（正则只匹配开标签，
 * 已带 style 的标签跳过）。导出 HTML 与富文本剪贴板共用，保证两边排版一致。
 */
function applyInlineStyles(html: string): string {
  return html.replace(/<([a-z0-9]+)((?:\s[^>]*)?)>/gi, (match, tag: string, attrs: string) => {
    const style = MP_INLINE_STYLES[tag.toLowerCase()]
    if (!style || /style\s*=/i.test(attrs)) return match
    return `<${tag}${attrs} style="${style}">`
  })
}

/**
 * 生成「公众号粘贴用富文本 HTML」：只含正文区块（外层 section 兜底字体/字号），
 * 全部样式内联（MP_INLINE_STYLES + applyInlineStyles），供剪贴板 text/html 复制，
 * 粘贴进公众号编辑器直接保留排版。
 */
export function buildArticleRichHtml(content: string, images: ImagePromptItem[]): string {
  const bodyHtml = applyInlineStyles(renderMarkdown(buildArticlePreviewMarkdown(content, images)))
  return `<section style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; font-size: 15px; line-height: 1.9; letter-spacing: 0.5px; color: #3f3f3f; padding: 0 8px;">${bodyHtml}</section>`
}

/**
 * 生成「文章 HTML 网页」：完整独立 HTML 文档（视图「在浏览器打开」「导出 .html」用）。
 * - 样式内联在文档 <style>，同时正文元素同步打上内联样式（applyInlineStyles），
 *   浏览器预览与富文本粘贴所见一致，且导出后单独拆正文也能带样式；
 * - 排版仿公众号：容器 677px 居中、正文 15px/1.9、字距 0.5px、两端对齐；
 *   h2 品牌橙左竖条、强调深橙、引用橙竖线浅橙底，与预览卡片样式一致；
 * - 正文复用 preview 模式 markdown（插图已上传成图时渲染真图，未上传渲染为 blockquote
 *   占位块），经 renderMarkdown（markdown-it + DOMPurify）消毒；
 * - 文首封面：已上传成图渲染 <img> 真图，未上传放占位框（图N · 封面图 · 2.35:1 · 请生成后上传）。
 */
export function buildArticleHtml(req: WritingRequirement, content: string, images: ImagePromptItem[]): string {
  const title = escapeHtml(extractFirstHeading(content) || req.topic)
  const author = escapeHtml(req.mpName || ARTICLE_AUTHOR)
  const coverIndex = images.findIndex((img) => img.role === 'cover')
  const cover = coverIndex >= 0 ? images[coverIndex] : undefined
  // dataURL 为 FileReader/canvas 产物（base64 字符集不含引号），可直接进 src 属性
  const coverSlot = cover
    ? cover.dataUrl
      ? `  <img class="cover-img" src="${cover.dataUrl}" alt="文章封面">\n`
      : `  <div class="img-slot">图${coverIndex + 1} · 封面图 · ${escapeHtml(cover.ratio)} · 请生成后上传</div>\n`
    : ''
  const bodyHtml = applyInlineStyles(renderMarkdown(buildArticlePreviewMarkdown(content, images)))
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; background: #f2f2f2; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .container { max-width: 677px; margin: 0 auto; padding: 32px 24px 48px; background: #ffffff; min-height: 100vh; box-sizing: border-box; }
  h1.title { margin: 0 0 8px; font-size: 22px; line-height: 1.4; font-weight: 700; color: #1c1917; }
  p.author { margin: 0 0 24px; font-size: 14px; color: #8c8c8c; }
  .img-slot { margin: 0 0 24px; padding: 48px 16px; border: 1px dashed #c9c9c9; border-radius: 8px; text-align: center; font-size: 14px; color: #8c8c8c; }
  .cover-img { width: 100%; margin: 0 0 24px; border-radius: 8px; display: block; }
  .content { font-size: 15px; line-height: 1.9; letter-spacing: 0.5px; color: #3f3f3f; overflow-wrap: anywhere; }
  .content p { margin: 0 0 16px; text-align: justify; }
  .content img { max-width: 100%; height: auto; border-radius: 8px; display: block; }
  .content h2 { margin: 32px 0 16px; padding-left: 10px; font-size: 17px; line-height: 1.5; font-weight: 700; color: #1c1917; border-left: 4px solid #ff6a00; }
  .content h3 { margin: 24px 0 12px; font-size: 16px; line-height: 1.5; font-weight: 700; color: #1c1917; }
  .content strong { font-weight: 700; color: #c95400; }
  .content em { font-style: normal; color: #c95400; }
  .content hr { width: 60px; margin: 28px auto; border: none; border-top: 1px solid #e4e1dc; }
  .content ul, .content ol { margin: 0 0 16px; padding-left: 1.4em; }
  .content li { margin: 6px 0; text-align: justify; }
  .content li::marker { color: #ff6a00; }
  .content blockquote { margin: 0 0 16px; padding: 12px 16px; border-left: 3px solid #ff6a00; background: #fff7f0; border-radius: 0 8px 8px 0; text-align: center; color: #57534e; font-size: 14px; }
  .content blockquote p { margin: 0; }
  .content code { padding: 2px 5px; background: #f5f3f0; border-radius: 4px; font-size: 13px; color: #c95400; }
  .content pre { padding: 12px 16px; background: #f5f3f0; border-radius: 8px; overflow-x: auto; }
  .content a { color: #e85f00; }
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
