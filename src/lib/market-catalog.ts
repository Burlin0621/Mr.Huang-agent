/**
 * 技能市场内置精选索引：手工整理的真实 Agent Skills 开源仓库条目。
 * 纯数据模块（零依赖），条目路径均已通过 GitHub Contents API 实测核验
 * （anthropics/skills 与 obra/superpowers 的技能子目录）。
 *
 * 安装时由市场组件拼出 `https://github.com/{owner}/{repo}/tree/{branch}/{path}`
 * 交给 fetchSkillFromGithub 拉取；path 为空串表示仓库根（走仓库默认分支）。
 */

export type MarketSkillCategory = '效率工具' | '开发编程' | '数据处理' | '写作创作' | '设计' | '其他'

/** 无匹配内置智能体时的通用挂载建议（与卡片「适合挂载」栏共用） */
export const GENERAL_AGENT_SUGGESTION = '通用对话智能体，或新建专用智能体'

/** 内置智能体名（src/lib/agents.ts BUILTIN_AGENTS 的展示名，用于挂载建议） */
const AGENT_CODE = '代码助手'
const AGENT_SMM = '社媒运营专家'
const AGENT_FRONT = '大B'

/** 技能市场单条目（内置精选与 GitHub 在线搜索结果共用同一卡片结构） */
export interface MarketSkill {
  name: string
  owner: string
  repo: string
  /** 分支名；空串走仓库默认分支 */
  branch: string
  /** 仓库内技能子目录；空串表示仓库根（单技能仓库） */
  path: string
  /** 中文一句话描述（超长由 UI 截断） */
  description: string
  /** 具体用途说明（1~2 句，比 description 更详细） */
  detail: string
  /** 推荐挂载的智能体（内置智能体名或通用建议文案） */
  suggestedAgents: string[]
  category: MarketSkillCategory
  /** 展示用 emoji 图标 */
  icon: string
  /** 星数（仅在线搜索结果携带；内置精选不填） */
  stars?: number
}

/** 市场全部分类（含「全部」由 UI 侧追加） */
export const MARKET_CATEGORIES: readonly MarketSkillCategory[] = [
  '效率工具',
  '开发编程',
  '数据处理',
  '写作创作',
  '设计',
  '其他',
]

/** 通用挂载建议（无内置智能体匹配时）：大B 亲自接待或新建专用智能体 */
function generalAgents(): string[] {
  return [`${AGENT_FRONT}（通用接待）`, GENERAL_AGENT_SUGGESTION]
}

/** 便捷构造：anthropics/skills 仓库的技能子目录条目 */
function ant(
  name: string,
  path: string,
  description: string,
  detail: string,
  suggestedAgents: string[],
  category: MarketSkillCategory,
  icon: string,
): MarketSkill {
  return { name, owner: 'anthropics', repo: 'skills', branch: 'main', path, description, detail, suggestedAgents, category, icon }
}

/** 便捷构造：obra/superpowers 仓库的技能子目录条目 */
function sp(
  name: string,
  path: string,
  description: string,
  detail: string,
  suggestedAgents: string[],
  category: MarketSkillCategory,
  icon: string,
): MarketSkill {
  return {
    name,
    owner: 'obra',
    repo: 'superpowers',
    branch: 'main',
    path: `skills/${path}`,
    description,
    detail,
    suggestedAgents,
    category,
    icon,
  }
}

/** 内置精选技能索引（34 条，均为已核验存在的技能目录） */
export const MARKET_CATALOG: MarketSkill[] = [
  /* —— 效率工具 —— */
  ant(
    'PDF 处理', 'pdf', '提取、拆分、合并与生成 PDF 文档，处理表单填写',
    '解析 PDF 提取正文与表格、按页拆分或合并多个文件、生成新 PDF，并能自动填写表单字段；适合处理合同、报告等扫描件之外的常规 PDF。',
    generalAgents(), '效率工具', '📄',
  ),
  ant(
    'Word 文档', 'docx', '创建与编辑 Word（.docx）文档，支持修订与批注',
    '按大纲生成 .docx 文档（标题、表格、图片），或在既有文档上做修订、添加批注与修订追踪，适合正式报告与公文流转场景。',
    generalAgents(), '效率工具', '📝',
  ),
  ant(
    'PPT 演示', 'pptx', '从零创建或改写 PowerPoint（.pptx）演示文稿',
    '从主题或大纲出发生成整套 .pptx 幻灯（版式、图表、演讲者备注），也可对现有幻灯做批量改写与美化。',
    generalAgents(), '效率工具', '📊',
  ),
  ant(
    'Excel 表格', 'xlsx', '读写与加工 Excel（.xlsx）表格，支持公式与图表',
    '读取 .xlsx 数据做清洗、透视与统计，写入公式、条件格式与图表后回存；适合报表加工与数据整理类任务。',
    generalAgents(), '效率工具', '📈',
  ),
  ant(
    '内部通讯撰写', 'internal-comms', '撰写面向组织内部的公告、周报与通知文案',
    '按组织内沟通的语气与格式撰写公告、周报、变更通知与 FAQ，结构清晰、少套话；也可对草稿做语气与合规润色。',
    [AGENT_SMM, ...generalAgents()], '效率工具', '📣',
  ),
  ant(
    '文档协同创作', 'doc-coauthoring', '以协作者身份与人共同起草、迭代与打磨文档',
    '以协作方式陪跑文档写作：先对齐目标与读者，再分轮起草、收集反馈、迭代修订，适合规格说明、方案书等长文档的打磨过程。',
    generalAgents(), '效率工具', '🤝',
  ),
  sp(
    '计划执行', 'executing-plans', '按既定计划逐任务推进开发并在每个节点验证',
    '把一份开发计划拆成带验收标准的任务清单，逐条执行并在每个节点跑验证，遇到偏差先回滚再修订计划，避免一口气写完才发现跑偏。',
    [AGENT_CODE], '效率工具', '✅',
  ),
  sp(
    '完成开发分支', 'finishing-a-development-branch', '按规范收尾开发分支：测试、合并与清理',
    '分支收尾的标准流程：跑全量测试 → 处理冲突 → 合并回主干 → 清理本地分支与 worktree，防止半成品分支长期悬空。',
    [AGENT_CODE], '效率工具', '🏁',
  ),

  /* —— 开发编程 —— */
  ant(
    'MCP 服务构建', 'mcp-builder', '引导式构建高质量的 Model Context Protocol（MCP）服务器',
    '引导式搭建 MCP 服务器：定义工具与资源、生成服务骨架、按协议规范自测，适合想把内部能力封装成工具供智能体调用的场景。',
    [AGENT_CODE], '开发编程', '🔧',
  ),
  ant(
    '技能创建器', 'skill-creator', '创建符合规范的自定义 Agent Skill（SKILL.md 技能包）',
    '从需求描述出发生成结构规范的 SKILL.md 技能包（frontmatter、触发条件、方法论正文），并迭代优化触发可靠性，适合沉淀团队自己的技能。',
    [AGENT_CODE], '开发编程', '🧩',
  ),
  ant(
    'Web 应用测试', 'webapp-testing', '用 Playwright 驱动浏览器对 Web 应用做端到端测试',
    '用 Playwright 启动真实浏览器执行点击、填表、截图与断言，对 Web 应用做端到端回归；也可复现「页面上按钮点了没反应」类问题。',
    [AGENT_CODE], '开发编程', '🧪',
  ),
  ant(
    'Claude API 开发', 'claude-api', '正确使用 Anthropic Claude API 进行应用开发与调优',
    '按最新 API 规范接入 Claude：消息结构、工具调用、流式输出、长上下文与提示词调优，避免用过期参数或错误的消息格式。',
    [AGENT_CODE], '开发编程', '🛠️',
  ),
  ant(
    '网页工件构建', 'web-artifacts-builder', '用 React 等技术栈构建复杂的前端工件（artifacts）',
    '在对话环境里构建可交互的前端工件：React 组件、多页面交互、状态管理，产出可直接预览的 HTML/JS 产物。',
    [AGENT_CODE], '开发编程', '🧱',
  ),
  sp(
    '系统化调试', 'systematic-debugging', '四阶段系统化定位根因，拒绝盲目试错式修 bug',
    '按「复现 → 收敛范围 → 形成假设 → 验证」四阶段定位根因，先读懂报错与数据流再动手，禁止不找根因就乱改一通。',
    [AGENT_CODE], '开发编程', '🐞',
  ),
  sp(
    '测试驱动开发', 'test-driven-development', '红-绿-重构：严格遵循 TDD 节奏编写代码',
    '先写失败的测试（红），再写最小实现让它通过（绿），最后重构；用测试锁住行为，适合核心逻辑与修复回归场景。',
    [AGENT_CODE], '开发编程', '🟩',
  ),
  sp(
    'Git Worktree 使用', 'using-git-worktrees', '用 git worktree 并行管理多个开发分支互不干扰',
    '用 git worktree 为每个任务开独立工作目录，多任务并行开发互不踩踏，避免频繁 stash 与切分支造成的现场丢失。',
    [AGENT_CODE], '开发编程', '🌿',
  ),
  sp(
    '提交代码评审', 'requesting-code-review', '在提交评审前自检清单并准备好评审上下文',
    '提审前先自检：改动范围、测试证据、潜在风险点，并把评审人需要的上下文整理清楚，让评审更快也更准。',
    [AGENT_CODE], '开发编程', '📤',
  ),
  sp(
    '接收代码评审', 'receiving-code-review', '以正确姿态处理评审意见：验证、讨论与落实',
    '收到评审意见先验证是否属实，再逐条回应与落实；有理有据地讨论分歧，不盲从也不防御，保证评审闭环。',
    [AGENT_CODE], '开发编程', '📥',
  ),
  sp(
    '子代理驱动开发', 'subagent-driven-development', '把任务分派给子代理执行并逐个验收结果',
    '把大任务拆成独立子任务逐个派给子代理，每个子任务带明确验收标准，主代理只负责拆解与验收，适合多步骤复杂工程。',
    [AGENT_CODE], '开发编程', '🤖',
  ),
  sp(
    '并行代理调度', 'dispatching-parallel-agents', '识别可并行任务并一次性派发多个子代理',
    '识别任务间无依赖的部分一次性并行派发，有依赖的保持串行；用并发缩短总时长，同时明确汇总与验收节点。',
    [AGENT_CODE], '开发编程', '🚀',
  ),
  sp(
    '编写开发计划', 'writing-plans', '把模糊需求落成可执行的详细开发计划文档',
    '把一句话需求追问澄清后写成可执行计划：任务拆解、依赖顺序、每步的验证方式与完成标准，供后续照单执行。',
    [AGENT_CODE, ...generalAgents()], '开发编程', '🗒️',
  ),
  sp(
    '编写新技能', 'writing-skills', '写出结构清晰、触发可靠的高质量 Agent Skill',
    '总结可复用方法论并沉淀为 Agent Skill：怎么写描述才能稳定触发、正文如何组织、常见反模式（过长、过泛、互相覆盖）如何规避。',
    [AGENT_CODE], '开发编程', '✍️',
  ),
  sp(
    '完成前验证', 'verification-before-completion', '声明「完成」之前强制进行系统化验证',
    '在宣布任务完成前强制走验证清单：跑测试、核对验收标准、确认无遗留报错，杜绝「应该没问题」式的口头完成。',
    [AGENT_CODE], '开发编程', '🔎',
  ),
  sp(
    '头脑风暴', 'brainstorming', '在动手前通过结构化提问把想法打磨成方案',
    '动手前先发散再收敛：结构化提问澄清目标与约束，给出多个备选方案与取舍，最终敲定一份可执行方案，避免上来就写错方向。',
    generalAgents(), '开发编程', '💡',
  ),

  /* —— 数据处理 —— */
  ant(
    '算法艺术生成', 'algorithmic-art', '用 p5.js 风格的算法生成 generative 艺术作品',
    '用 p5.js 风格的算法按主题生成 generative 视觉作品（粒子、流场、几何图案），可调参数批量出图，适合海报底纹与创意素材。',
    generalAgents(), '数据处理', '🎨',
  ),

  /* —— 写作创作 —— */
  ant(
    'Slack GIF 创作', 'slack-gif-creator', '为 Slack 制作表情动画 GIF（基于 ffmpeg 命令）',
    '用 ffmpeg 把静态创意合成符合 Slack 尺寸与帧率要求的表情动画 GIF，适合做团队表情包与轻量视觉素材。',
    [AGENT_SMM], '写作创作', '🎞️',
  ),

  /* —— 设计 —— */
  ant(
    '画布设计', 'canvas-design', '以设计师视角产出海报与视觉设计 PNG 作品',
    '以设计师的构图、配色与字体思路直接产出 PNG 视觉作品（海报、封面、卡片），注重留白、层次与视觉重心，而非简单拼贴。',
    generalAgents(), '设计', '🖼️',
  ),
  ant(
    '品牌规范', 'brand-guidelines', '按品牌规范使用官方配色与字体进行设计',
    '在给定品牌规范（logo 用法、色板、字体层级）约束下做设计，保证多张产出风格一致，适合有 VI 要求的对外物料。',
    generalAgents(), '设计', '🏷️',
  ),
  ant(
    '主题工厂', 'theme-factory', '为作品与幻灯快速生成成套的主题样式',
    '为文档、幻灯与页面批量生成成套主题（配色、字体、背景），一次定义多处套用，避免每页手调样式风格漂移。',
    generalAgents(), '设计', '🎭',
  ),
  ant(
    '前端设计', 'frontend-design', '产出有独特品味、不落俗套的前端界面设计',
    '从前端视角做界面设计决策：排版层级、留白节奏、状态与动效，产出有辨识度而非模板化的页面实现方案。',
    [AGENT_CODE], '设计', '✨',
  ),
  {
    name: 'impeccable',
    owner: 'pbakaus',
    repo: 'impeccable',
    branch: 'main',
    path: 'plugin/skills/impeccable',
    description: '前端设计打磨/审查技能：布局、排版、配色、动效、反模式审查',
    detail:
      '对既有前端界面做设计审查与打磨：识别「AI 味」反模式（默认蓝、等距卡片、滥用渐变），并给出布局、排版、配色、动效的具体改进。',
    suggestedAgents: [AGENT_CODE],
    category: '设计',
    icon: '🎨',
  },

  /* —— 其他 —— */
  ant(
    '新手学院指南', 'academy-guide', 'Anthropic Academy 课程学习路径与指南',
    '提供 Anthropic Academy 官方课程的学习路径导航：按基础/进阶选择课程与动手实验，适合系统学习 API 与智能体开发。',
    generalAgents(), '其他', '🎓',
  ),
  ant(
    '洞察提示', 'discernment-nudge', '在关键决策处提醒保持审慎与独立判断',
    '在关键决策节点插入审慎提醒：核对事实来源、警惕从众与过度自信，帮助在方案评审与判断类任务中保持独立思考。',
    generalAgents(), '其他', '🧭',
  ),
  sp(
    '超能力使用指南', 'using-superpowers', 'superpowers 技能集的入口与使用方式总览',
    'superpowers 技能集的总入口：说明包含哪些技能、何时触发哪一篇、如何组合使用，是安装该技能集后首先该装的导航技能。',
    [AGENT_CODE, ...generalAgents()], '其他', '📚',
  ),
  sp(
    '超能力问题诊断', 'diagnosing-superpowers', '排查 superpowers 技能集安装与触发问题',
    '排查 superpowers 技能集装不上、不被触发的常见原因：安装位置、命名冲突、触发词不匹配，并给出修复步骤。',
    [AGENT_CODE], '其他', '🩺',
  ),
]

/* —— 在线搜索结果的挂载建议推断 —— */

/** 关键词 → 挂载建议规则（按顺序命中第一条；均不命中走通用建议） */
const AGENT_MATCH_RULES: ReadonlyArray<{ keywords: readonly string[]; agents: readonly string[] }> = [
  { keywords: ['pdf', 'docx', 'xlsx', 'pptx', 'document', 'office', 'spreadsheet', '文档', '表格'], agents: generalAgents() },
  { keywords: ['design', 'ui', 'ux', 'frontend', 'art', 'theme', 'brand', 'css', '设计', '界面'], agents: [AGENT_CODE, '设计类智能体（如新建「UI 原型设计」）'] },
  { keywords: ['write', 'writing', 'content', 'copy', 'marketing', 'social', 'blog', '文案', '写作', '营销', '公众号'], agents: [AGENT_SMM] },
  { keywords: ['code', 'debug', 'test', 'git', 'api', 'dev', 'program', 'refactor', '代码', '调试', '测试'], agents: [AGENT_CODE] },
]

/** 按描述关键词推断在线搜索结果的挂载建议（与内置条目同一套映射逻辑） */
export function inferSuggestedAgents(description: string): string[] {
  const text = description.toLowerCase()
  for (const rule of AGENT_MATCH_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return [...rule.agents]
  }
  return generalAgents()
}
