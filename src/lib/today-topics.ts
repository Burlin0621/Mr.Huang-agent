/**
 * 今日选题工作流：阶段定义与提示词组装（纯函数，便于单测）
 *
 * 三个 block：前两个为 LLM 阶段（热点扫描 → 选题评估，顺序串联），
 * 第三个「选题卡片」为纯展示阶段（解析第二阶段产出的严格 JSON 并渲染推荐卡片），不发起模型请求。
 * 每个阶段的 system = 社媒运营专家 systemPrompt + 阶段专属指令；
 * user = 用户账号偏好 + 前序阶段的产出文本。
 */

/** 顶部偏好输入区三要素 */
export interface TopicPreference {
  /** 账号定位 / 擅长领域（选填） */
  positioning: string
  /** 目标读者（选填） */
  audience: string
  /** 偏好平台 */
  platform: string
}

/** LLM 阶段 id（卡片展示阶段不在此列，由视图直接解析评估产出） */
export type TopicStageId = 'hotspots' | 'evaluate'

/** 偏好平台下拉可选项 */
export const TOPIC_PLATFORMS = ['公众号', '小红书', '抖音', '知乎', '不限定'] as const

/** 单个 LLM 阶段的定义 */
export interface TopicStageDef {
  id: TopicStageId
  /** 卡片标题 */
  title: string
  /** 卡片副标题（一句话说明本阶段做什么） */
  hint: string
  /** 阶段专属指令（拼进 system 与 user 消息） */
  taskPrompt: string
  /** 是否携带工具（仅热点扫描阶段在桌面端带联网工具） */
  useTools: boolean
}

/** 两个 LLM 阶段的顺序定义 */
export const TOPIC_STAGES: TopicStageDef[] = [
  {
    id: 'hotspots',
    title: '热点扫描',
    hint: '扫描多平台热点、爆款选题与近期时效节点',
    useTools: true,
    taskPrompt: `请完成「热点扫描」阶段：
1. 先调用 current_time 工具获取今天的日期与星期，作为时效判断基准；如果没有时间工具，基于上下文推断今天日期并在结论处标注「推断」；
2. 优先使用 web_search 工具做关键词搜索（可搜 2-4 组不同关键词，如「今日热点」「<账号定位相关主题> 最新动态」，并用 recency=oneDay/oneWeek 限定近期），扫描多个内容平台（微信公众号、小红书、抖音、知乎、微博等）近 24-48 小时的热点事件、爆款选题与正在上升的话题，并注明信息来源；对搜索结果中的重要来源再用 http_get 或 browser_navigate+browser_read 深入阅读；搜索引擎无结果时，基于你的知识给出近期热点判断并标注「推断」；
3. 同时梳理未来 3 天内的时效节点（节日、纪念日、行业大事件等）中可借势的选题；
4. 注意控制工具调用总数（建议不超过 6 次，含 current_time），避免耗尽步骤；工具阶段结束后必须直接输出正文，不要只调用工具不输出结论；
5. 对无法核实、属于经验判断的结论，必须在该句末尾标注「（推断）」；
6. 直接输出一份「今日热点简报」：分「热点事件 / 上升话题 / 时效节点 / 平台风向」四小节，每节 3-5 条要点，不要客套话。`,
  },
  {
    id: 'evaluate',
    title: '选题评估与推荐',
    hint: '结合账号定位筛选 4-8 个今日可写话题，输出结构化推荐',
    useTools: false,
    taskPrompt: `请基于上一阶段的热点简报完成「选题评估与推荐」阶段：
结合账号定位、目标读者与偏好平台，从热点简报中筛选 4-8 个适合该账号今天写的话题，按推荐度从高到低排序，并严格按以下 JSON 格式输出（只返回 JSON 本身，不要输出任何解释文字、开场白或代码块标记）：
{"picks":[{"topic":"话题名","heat_reason":"为什么今天适合写（1-2 句）","angles":["切入角度1","切入角度2"],"audience":"适合的读者","platforms":["公众号"],"score":8.5,"title_samples":["示例标题1","示例标题2"],"risk_note":"合规/风险提示，没有则为空字符串"}]}
字段要求：score 为 0-10 的推荐分（保留一位小数）；angles 给 2-3 个切入角度；title_samples 给 1-2 个示例标题；platforms 从「公众号/小红书/抖音/知乎」中选择；risk_note 涉及医疗、财经、时政等敏感领域时必须给出提示。`,
  },
]

/** 把账号偏好汇总为可读文本（随每个阶段的 user 消息携带） */
export function buildPreferenceText(req: TopicPreference): string {
  return [
    `- 账号定位/擅长领域：${req.positioning || '未指定'}`,
    `- 目标读者：${req.audience || '未指定'}`,
    `- 偏好平台：${req.platform || '不限定'}`,
  ].join('\n')
}

/** 组装阶段 system 消息：智能体 systemPrompt + 阶段专属指令 */
export function buildStageSystemMessage(stage: TopicStageDef, agentSystemPrompt: string): string {
  return `${agentSystemPrompt}\n\n## 当前任务阶段：${stage.title}\n${stage.taskPrompt}`
}

/**
 * 组装阶段 user 消息：账号偏好 + 前序阶段产出文本 + 本阶段任务提醒。
 * prev 为此前已完成阶段的产出（缺省时给出占位说明）。
 */
export function buildStageUserMessage(
  stage: TopicStageDef,
  req: TopicPreference,
  prev: Partial<Record<TopicStageId, string>>,
): string {
  const sections: string[] = [`### 账号偏好\n${buildPreferenceText(req)}`]

  if (stage.id === 'evaluate') {
    sections.push(
      prev.hotspots
        ? `### 上一阶段产出：今日热点简报\n${prev.hotspots}`
        : '### 上一阶段产出：今日热点简报\n（未提供，请基于你的知识自行梳理今日热点后再评估，推断性结论请标注「推断」）',
    )
  }

  sections.push(`### 本阶段任务\n${stage.taskPrompt}`)
  return sections.join('\n\n')
}

/** 单条选题推荐（对应评估阶段输出的 picks 数组元素） */
export interface TopicPick {
  /** 话题名 */
  topic: string
  /** 为什么今天适合写 */
  heatReason: string
  /** 切入角度 */
  angles: string[]
  /** 适合的读者 */
  audience: string
  /** 适配平台 */
  platforms: string[]
  /** 推荐分（0-10） */
  score: number
  /** 示例标题 */
  titleSamples: string[]
  /** 合规/风险提示（可为空串） */
  riskNote: string
}

/** 从模型返回文本中提取选题推荐 JSON；无法解析时返回 null（调用方按原文 Markdown 兜底展示） */
export function parsePicks(raw: string): TopicPick[] | null {
  // 兼容模型把 JSON 包在 ```json 代码块或前后闲聊中的情况：截取首个 { 到最后一个 }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    if (!Array.isArray(data.picks)) return null
    const picks: TopicPick[] = []
    for (const item of data.picks) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const topic = typeof record.topic === 'string' ? record.topic.trim() : ''
      if (!topic) continue
      picks.push({
        topic,
        heatReason: typeof record.heat_reason === 'string' ? record.heat_reason.trim() : '',
        angles: pickStringList(record.angles, 3),
        audience: typeof record.audience === 'string' ? record.audience.trim() : '',
        platforms: pickStringList(record.platforms, 4),
        score: typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : 0,
        titleSamples: pickStringList(record.title_samples, 2),
        riskNote: typeof record.risk_note === 'string' ? record.risk_note.trim() : '',
      })
    }
    return picks.length > 0 ? picks : null
  } catch {
    return null
  }
}

/** 宽松提取字符串数组：过滤非字符串与空串，最多保留 limit 个 */
function pickStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, limit)
}
