/**
 * 内置提示词模板清单（只读数据）：
 * 提示词库页面合并展示内置与自定义条目，内置条目不可编辑/删除，仅供复制与使用。
 */

/** 内置提示词条目结构（与 stores/prompts.ts 的 PromptView 对齐的只读子集） */
export interface BuiltinPrompt {
  id: string
  name: string
  description: string
  /** 提示词正文，支持 {{变量}} 占位符 */
  content: string
  icon: string
  tags: string[]
  /** 来源标记：内置 */
  source: 'builtin'
}

/** 内置提示词模板清单 */
export const BUILTIN_PROMPTS: BuiltinPrompt[] = [
  {
    id: 'builtin-prompt-polish',
    name: '文章润色',
    description: '优化文章表达，保留原意的同时提升流畅度与感染力',
    icon: '✨',
    tags: ['写作', '润色'],
    source: 'builtin',
    content: `你是一位资深中文编辑。请润色下面这篇文章：
- 保持原意与作者语气不变，不新增事实性内容；
- 修正错别字、语病与不自然的表达；
- 让句子更流畅、节奏更好，避免堆砌辞藻；
- 最后用列表逐条说明你做了哪些主要修改及理由。

【原文】
{{原文}}`,
  },
  {
    id: 'builtin-prompt-weekly-report',
    name: '周报生成',
    description: '把零散的工作记录整理成结构清晰的周报',
    icon: '📋',
    tags: ['办公', '总结'],
    source: 'builtin',
    content: `你是一位高效的职场助理。请根据我提供的本周工作记录，生成一份结构化周报，格式如下：
1. 本周概览：3 句以内概括整体进展；
2. 已完成：按重要性列出关键产出，每条注明结果或数据；
3. 进行中：列出未完结事项与当前进度；
4. 风险与求助：列出阻塞点，标注是否需要上级协调；
5. 下周计划：给出 3-5 条可执行的下一步。

要求：语言精炼、用数据说话、不虚构未提供的内容。

【本周工作记录】
{{工作记录}}`,
  },
  {
    id: 'builtin-prompt-code-review',
    name: '代码审查',
    description: '审查代码改动，指出问题并给出可执行的改进建议',
    icon: '🔍',
    tags: ['开发', '代码'],
    source: 'builtin',
    content: `你是一位严谨的资深工程师，请审查以下代码/改动，输出审查意见：
- 正确性：边界条件、异常处理、并发与数据一致性风险；
- 可读性：命名、结构、重复代码，是否违反单一职责；
- 性能与安全：明显的性能隐患、注入/越权/敏感信息泄漏风险；
- 每条问题标注严重级别（🔴 必须修复 / 🟡 建议修改 / 🟢 可选优化），并给出修改示例代码；
- 最后给出一句话总体结论：是否可以合入。

【代码/改动】
{{代码}}`,
  },
  {
    id: 'builtin-prompt-meeting-notes',
    name: '会议纪要整理',
    description: '把会议录音转写或速记整理成规范的会议纪要',
    icon: '🗒️',
    tags: ['办公', '会议'],
    source: 'builtin',
    content: `你是一位专业的会议记录员。请把下面的会议原始记录整理成规范纪要，输出结构：
- 基本信息：主题、时间、参会人（如记录中有）；
- 核心讨论：按议题归纳各方观点与结论，去除口语化冗余；
- 决议事项：明确「已达成一致」的结论；
- 行动项：表格输出（事项 / 负责人 / 截止时间），记录中未提及的填「待确认」；
- 存疑点：列出记录模糊、需要会后核实的内容。

要求：忠实于原始记录，不编造未提及的结论。

【会议原始记录】
{{会议记录}}`,
  },
  {
    id: 'builtin-prompt-xhs-copy',
    name: '小红书文案',
    description: '生成符合小红书风格的高互动种草文案',
    icon: '📕',
    tags: ['营销', '文案'],
    source: 'builtin',
    content: `你是一位擅长小红书的内容创作者。请根据主题生成一篇小红书笔记文案：
- 标题：20 字内，带 1-2 个合适 emoji，制造好奇心或利益点；
- 正文：口语化、有真实感，多用短句和换行，穿插 emoji；开头 2 行抓住注意力，中间分点给出干货或体验，结尾引导互动（提问 + 相关话题）；
- 话题标签：文末给 5-8 个精准 hashtag；
- 语气真诚不夸大，避免绝对化用语与违禁词。

【主题/素材】
{{主题}}`,
  },
  {
    id: 'builtin-prompt-translation',
    name: '翻译润色',
    description: '信达雅的翻译，保留原文语气并符合目标语言习惯',
    icon: '🌐',
    tags: ['翻译', '写作'],
    source: 'builtin',
    content: `你是一位专业译者。请把下面的文本从 {{源语言}} 翻译成 {{目标语言}}，要求：
- 信：准确传达原文信息，不遗漏、不添加；
- 达：符合目标语言的表达习惯，不逐词直译；
- 雅：保留原文的语气与风格（正式/口语/幽默等）；
- 专业术语首次出现时在括号内附原文；歧义处给出脚注说明你的取舍。

输出格式：先给【译文】，再给【翻译说明】列出关键取舍点。

【原文】
{{原文}}`,
  },
]

/**
 * 提取正文中的 {{变量}} 名列表（按出现顺序去重；如「{{原文}}」→ ['原文']）
 */
export function extractTemplateVars(content: string): string[] {
  const vars: string[] = []
  for (const match of content.matchAll(/\{\{([^{}\n]+)\}\}/g)) {
    const name = match[1].trim()
    if (name && !vars.includes(name)) vars.push(name)
  }
  return vars
}

/**
 * 用给定的变量值表替换正文中的 {{变量}} 占位符；未提供值的变量原样保留
 */
export function fillTemplateVars(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{([^{}\n]+)\}\}/g, (raw, name: string) => {
    const value = values[name.trim()]
    return value != null && value.trim() ? value : raw
  })
}
