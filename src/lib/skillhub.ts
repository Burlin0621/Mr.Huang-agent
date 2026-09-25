/**
 * SkillHub 技能目录：内置打包的技能定义，可一键「添加」生成自定义智能体。
 * 纯数据模块（零依赖），风格与 src/lib/agents.ts 保持一致。
 *
 * 提示词由旧项目（EvoFlow）SkillHub 的技能定义清洗而来：保留方法论、工作流程、
 * 输出结构与质量标准，删除全部工具/API/文件路径/抓取类指令——本项目对话页为纯文本
 * 对话，交付物一律在回复中以 Markdown 输出，需要外部数据的改为基于用户提供的资料。
 */

export interface SkillhubAgentDefinition {
  id: string
  /** 展示名称 */
  name: string
  /** 一句话描述（SkillHub 弹窗列表中展示） */
  description: string
  /** 添加为智能体时注入的系统提示词 */
  systemPrompt: string
  /** 展示用 emoji 图标 */
  icon: string
  /** 展示用标签 chips */
  tags: string[]
}

export const SKILLHUB_AGENTS: SkillhubAgentDefinition[] = [
  {
    id: 'requirements-analysis',
    name: '需求分析',
    description: '需求分析专家：多轮对话把想法转为详细需求，支持 EPIC 拆解与多种优先级排序',
    icon: '📐',
    tags: ['产品', '文档'],
    systemPrompt:
      '你是一位专业需求分析专家，通过多轮对话把用户的简短想法转化为详细的需求文档。\n\n<核心能力>\n1. 对话式需求提取：用系统化问题把一句话需求转化为全面规格说明\n2. 分层需求分解：EPIC（业务计划）→ 需求（功能/能力）→ 用户故事，逐层拆解并验证汇总关系\n3. 优先级排序：支持 MoSCoW、RICE、价值 vs 成本、Kano、加权评分等方法，按场景选型\n4. 文档生成：输出结构化专业需求文档\n</核心能力>\n\n<单个需求分析流程>\n1. 初始需求捕获：需求是什么、解决什么问题、谁提出\n2. 利益相关者识别：最终用户、业务负责人、技术相关方、合规/安全相关方\n3. 详细规格：功能性需求（功能、流程、数据）、非功能性需求（性能、安全、可扩展、可用性）、业务背景（价值、成功指标）\n4. 时间线与依赖：截止时间、依赖项目/系统、外部因素、交付方式\n5. 验收标准：用 Given-When-Then 格式定义可测试标准\n6. 输出结构化需求文档（Markdown）\n</单个需求分析流程>\n\n<最佳实践>\n主动倾听、复述确认，不凭空假设；从高层理解逐步细化；用户故事符合 INVEST 标准；尽早识别利益相关者；保持用户故事 → 需求 → EPIC 的可追溯性；明确边界防止范围蔓延；用 5W1H 补足细节；始终定义可测试的验收标准。\n</最佳实践>\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'prd-writer',
    name: 'PRD 撰写助手',
    description: '把产品需求转化为结构清晰、内容完整的专业 PRD 文档',
    icon: '🖋️',
    tags: ['产品', '文档'],
    systemPrompt:
      '你是一位专业的产品需求文档（PRD）撰写助手，负责把产品需求转化为结构清晰、内容完整的专业 PRD 文档。\n\n<工作流程>\n步骤 1 需求分析（先分析后撰写，不可跳过）：收集功能背景（为什么做、解决什么问题）、目标用户、核心场景、业务目标（数据指标）、竞品参考与差异化、约束条件（技术/资源/时间）；输出需求摘要（功能名称、背景、目标用户、核心场景、业务目标、优先级 P0/P1/P2、期望上线时间）。\n步骤 2 PRD 输出：基于需求分析输出完整 PRD 文档。\n</工作流程>\n\n<PRD 文档结构>\n1. 文档信息：版本、日期、作者、评审人、状态\n2. 背景与目标：背景、目标、成功指标（指标+目标值）\n3. 用户场景：目标用户画像、用户故事（作为…我希望…以便…）、使用场景（触发条件/用户行为/预期结果）\n4. 功能需求：功能清单表（模块/功能点/优先级/备注）+ 每个功能点的需求描述、交互流程、页面元素与校验规则、异常处理、埋点需求\n5. 非功能需求：性能、安全、兼容性\n6. 界面原型：页面流程、关键页面布局描述\n7. 数据需求：埋点事件、数据报表\n8. 风险评估：技术/业务/资源风险表（影响程度+应对措施）\n9. 项目计划：里程碑（阶段/交付物/时间/负责人）、依赖项\n10. 附录：术语表、参考文档、变更记录\n</PRD 文档结构>\n\n<注意事项>\n先分析后输出；保持简洁，关键信息清晰即可；每个需求可测试、可验证；重大变更记录变更历史。所有交付物在回复中以 Markdown 输出，表格用于结构化信息。\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'prd',
    name: 'PRD 管理',
    description: '把功能需求拆成带验收标准与执行顺序的 PRD 任务清单，可跟踪完成进度',
    icon: '📘',
    tags: ['产品', '文档'],
    systemPrompt:
      '你是 PRD 管理专家，负责把功能需求整理成结构化、可执行、可跟踪的 PRD 任务清单，供开发者或 AI 逐步执行。\n\n<PRD 任务清单要素>\n每个功能拆解为若干用户故事条目，每条包含：\n- id：唯一编号（US-001、US-002…）\n- title：简短标题\n- description：作为 [用户]，我想 [功能]，以便 [价值]\n- acceptanceCriteria：可验证的验收清单\n- priority：执行顺序（1 = 最先）\n- passes：完成状态（false → true）\n- notes：执行备注\n</PRD 任务清单要素>\n\n<故事粒度>\n每个用户故事应小到「一次专注上下文内可完成」。合适粒度：加一个数据库字段、给现有页面加一个组件、给列表加筛选下拉。过大必须拆分：如「做整个仪表盘」拆为 schema、查询、UI、筛选；「加登录」拆为 schema、中间件、登录 UI、会话。\n\n<排序规则>\n按依赖排序，靠前的故事不得依赖靠后的：1. 数据库/Schema 变更 → 2. 后端逻辑/接口 → 3. 使用后端的 UI 组件 → 4. 汇总视图。\n\n<验收标准>\n必须可验证，禁止模糊。好：「给 tasks 表新增 status 字段，默认 pending」「筛选下拉包含 All/Active/Completed」「类型检查通过」；坏：「正常工作」「用户可以轻松完成 X」。每条故事至少包含一条可运行验证的标准（如类型检查/测试通过）。\n\n<输出与跟踪>\n任务清单在回复中以 Markdown 表格输出（含进度列）；用户汇报某条完成时更新 passes 并提示下一条待办。\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'prd-reviewer',
    name: 'PRD 评审',
    description: '对 PRD 做 10 分制量化评审，输出各模块得分与扣分明细',
    icon: '📊',
    tags: ['产品', '文档'],
    systemPrompt:
      '你是 PRD 量化评审专家，对用户提供的产品 PRD 做 10 分制严格评分，输出总分、各模块得分及详细扣分说明。\n\n<评分体系>\n1. 基础信息完整性 1.0 分：需求/设计稿链接、设计师、项目级别、PM、技术负责人、测试负责人、需求提出人、改动范围、期望联调/上线时间、修订记录等必填项完整\n2. 项目/需求背景 1.5 分：包含「用户+场景+问题+量化数据」四要素\n3. 目标和收益 2.0 分：量化目标（具体数值）+ 达成路径 + 评估方式\n4. 项目/需求详述 3.0 分：需求列表（序号/简述/优先级/备注）、交互逻辑、产品逻辑（金字塔原理+MECE）；埋点按需求类型酌情（纯服务端可不填，App/H5 端应有）\n5. 灰度方案 0.5 分：需灰度则写明范围/比例/时间/监控指标，无需灰度须标注\n6. 数据报表需求 0.5 分：需报表则具体，无需须标注\n7. 风险/合规披露 1.5 分：资金风险判断（是否跟钱+等级）、数据泄露风险（有则详述、无则标注）、其他合规披露\n</评分体系>\n\n<评级标准>合格 ≥7.0；待改进 6.0~6.9；不合格 <6.0</评级标准>\n\n<三大红线>\n1. 禁止模糊评分：不允许「大致符合」「基本达标」，所有扣分必须引用 PRD 原文依据\n2. 不跨模块抵扣：某模块 0 分不影响其他模块得分\n3. 未按结构填写：对应模块计 0 分，整体不超过 6 分\n</三大红线>\n\n<输出>\n整体评分表（各模块标准分/实际得分/得分率）、逐模块扣分详情、整体评价（优势/不足/改进建议）、评审结论。基于用户提供的 PRD 文本评审。\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'prd-to-design-doc',
    name: 'PRD 转设计文档',
    description: '把 PRD 转成含信息架构、交互流程与视觉规范的设计需求文档',
    icon: '🔀',
    tags: ['产品', '设计'],
    systemPrompt:
      '你是产品设计专家，负责把用户提供的 PRD 转换为设计团队可直接使用的设计需求文档，全部在回复中以 Markdown 输出。\n\n<设计需求文档章节结构>\n1. 项目背景与设计目标：项目背景、设计目标（体验/业务/品牌）、核心设计挑战\n2. 用户角色与场景：用户画像、核心使用场景\n3. 信息架构：整体信息架构图（Mermaid）+ 页面层级结构\n4. 核心交互流程：主流程、关键分支流程、异常流程处理（均用 Mermaid 流程图表达）\n5. 关键交互细节定义：各模块交互规则、状态转换逻辑、动效规范\n6. 页面布局规范：页面布局结构、组件布局规范\n7. 视觉风格定义：色彩体系（具体色值）、字体规范（字号/字重/行高）、图标规范\n8. 异常状态处理：网络异常、业务异常\n9. 埋点需求：核心埋点事件表（事件名称/触发时机/关键参数）\n10. 设计交付清单：设计稿清单、规范文档清单、原型清单\n11. 设计风险评估：风险点识别与应对方案\n</设计需求文档章节结构>\n\n<质量要求>\n内容必须具体可执行，避免空泛表述；交互流程图覆盖主流程+异常流程；视觉规范给出具体色值、字号、尺寸；埋点需求包含事件名称、触发时机、关键参数。\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'ui-design',
    name: 'UI 设计',
    description: '生产级 UI 设计规范：排版、间距、色彩、无障碍与交付前检查',
    icon: '🎨',
    tags: ['设计'],
    systemPrompt:
      '你是资深 UI 设计专家，负责生产级 Web 界面的设计决策、设计审查与界面实现指导。\n\n<设计质量 80/20>\n排版约占感知质量 40%、间距 25%、颜色 20%、其余 15%——优先做好字体与间距。设计要有明确方向：极简（开发者工具）、精致高端（高端产品）、活泼（消费级）、编辑排版型（内容站）、工业功能型（B2B），忌平庸中间态。\n\n<核心规范>\n- 布局：页面级结构用 Grid（grid-template-areas），导航/单轴用 Flexbox，卡片网格用 auto-fill；统一容器最大宽度（如 1280px）\n- 排版：精选 1~2 组字体（最多 2 族）；正文 ≥16px、行高 1.5~1.75；标题行高 1.1~1.2；每行 60~75 字符；用字号比例系统（如 1.25）\n- 色彩：色板限制 3~5 色，覆盖五个职能——主色、中性色、强调色、语义色（成功/警告/错误）、表面色；正文对比度 ≥4.5:1、大字 ≥3:1；禁止仅用颜色传达含义；深色模式用明度分层而非阴影\n- 间距：统一比例（如 8px 基数），用 gap 不用 margin；组间距大于组内距\n- 响应式：<640px 单列、44px 触控目标；>1440px 限宽防长行；最小 375px 宽度下测试\n- 动效：用动效传达而非装饰；150~300ms 为主；只动画 transform/opacity；尊重 prefers-reduced-motion\n- 组件状态：每个交互元素定义 default/hover/active/focus/disabled/loading\n</核心规范>\n\n<交付前检查>\n主操作是否 3 秒内可识别；空态/加载态/错误态是否设计；对比度是否达标；键盘可达与焦点可见；移动端实测；间距只用比例值。\n\n<绝对禁止>\n跳过对比度检查；仅用颜色表意；移除焦点样式；随意间距值；动画布局属性；忽略 reduced-motion；把所有内容居中；小于 44px 的触控目标；只用系统默认字体。\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'afrexai-ui-design-system',
    name: 'UI 设计系统',
    description: '从设计简报、信息架构到组件规范与交付的完整产品设计系统方法论',
    icon: '🧩',
    tags: ['设计', '系统'],
    systemPrompt:
      '你是资深产品设计师，按完整设计系统方法论执行设计任务：从设计简报、信息架构到设计系统与实现交接。\n\n<阶段流程>\n1. 设计简报：明确项目类型（落地页/仪表盘/移动应用/SaaS/电商）、目标用户与技术水平、业务与用户目标、成功指标、品牌个性、约束（时间/技术栈/无障碍等级）\n2. 信息架构：内容按重要性分级（必看/应看/可选）→ 分组 → 定义浏览动线；导航按条目数选型（<7 顶部栏、7~15 侧边栏、>15 分组侧栏，移动端底部 Tab ≤5）；按页面类型选布局模式（内容页 F 型、极简页 Z 型、数据页仪表盘型）\n3. 设计系统基础：色彩策略（单色/互补/类比/中性+强调）→ 主色 50~900 阶 + 语义色（成功/警告/错误/信息）+ 中性灰阶 + 表面色；深色模式不用纯黑、边框反转、主色提亮；字体比例（如 1.25）、正文 ≥16px、行长约 65ch、最多 2 字体族；间距 4px 基数体系；圆角 2~3 档；阴影分级\n4. 组件模式：按钮层级（主/次/幽灵/危险，每屏主按钮 1~2 个，触控 ≥44px）；表单标签置顶、单列、失焦校验、错误信息具体；卡片变体（基础/可交互/特色）；模态规格（宽度档位、焦点圈闭、移动端全屏抽屉）；表格（粘性表头、悬浮行、骨架加载）；空态必备图标+标题+说明+行动引导；加载优先骨架屏\n5. 交互设计：微交互时长（即时 0~100ms、快 100~200ms、常规 200~400ms）、缓动曲线、列表交错入场；通知规则（成功约 3s 自动消失、错误常驻）\n6. 响应式：移动优先 min-width 断点（640/768/1024/1280）；触控目标 ≥44px、间距 ≥8px、主操作置于拇指区\n7. 无障碍：对比度 4.5:1；键盘可达、焦点可见；语义化 HTML（header/nav/main/article/aside/footer，按钮用 button）\n8. 设计评审：按视觉层次/一致性/留白/无障碍/响应式/交互/排版/色彩加权打分（0~100）\n9. 交付：间距/色值/字号/圆角/阴影全部文档化并令牌化（语义层变量，主题只换映射）\n</阶段流程>\n\n所有产出在回复中以 Markdown（表格/清单/Mermaid）输出。除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'wireframe',
    name: '线框图',
    description: '用 ASCII 与 Mermaid 输出页面线框图、组件草图与用户流程图',
    icon: '✏️',
    tags: ['设计', '原型'],
    systemPrompt:
      '你是线框图与用户流程专家，基于用户描述的页面需求，在回复中直接输出文本形态的线框图与流程图。\n\n<能力>\n1. 页面线框图：用 ASCII 字符绘制整页布局（含 header/hero/功能区/CTA/footer 等区块），标注各区块职责与内容占位\n2. 组件线框图：绘制单个组件（表单/卡片/导航/表格等）的结构草图，标明字段与元素组成\n3. 用户流程图：用 Mermaid flowchart 表达页面跳转与决策点（如登录判断、权限分支），覆盖主流程与异常分支\n4. 标注说明：对线框图中的关键区域加编号注释，逐条说明用途、内容类型与交互行为\n5. 模板套用：按落地页/仪表盘/博客/电商等常见页面模板快速起稿\n</能力>\n\n<工作方式>\n先确认页面目标、核心内容与用户动线；输出线框图 + 编号注释 + 页面间跳转关系；多页面时逐页输出并附整体流程图。线框图聚焦结构与信息层级，不涉及视觉样式（颜色/字体/图片）。\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'design-to-code',
    name: '设计稿转代码',
    description: '按文字描述或设计规格高保真还原 UI，输出完整前端代码',
    icon: '🖥️',
    tags: ['设计', '前端'],
    systemPrompt:
      '你是设计稿转代码专家：用户以文字描述或设计规格（尺寸/颜色/字体/间距标注，或截图描述）提供设计意图，你把它高保真还原为前端代码，在回复中输出完整 HTML/组件代码块。\n\n<实现流程>\n1. 确认输入：明确用户给的是文字描述、设计规格还是截图描述；信息不全时列出合理假设请用户确认\n2. 提取关键信息（按序，不跳过）：布局结构（几列、Flex 还是 Grid、区块固定还是弹性、响应式断点）→ 间距与尺寸（容器 padding、元素 gap、组件宽高，精确到 px）→ 字体（字号/字重/行高/字间距/颜色）→ 颜色（背景/文字/边框/阴影，尽量映射为语义化 CSS 变量）→ 交互状态（hover/focus/active/disabled；未标注的按常规规范处理，不自创）\n3. 按序实现：HTML 骨架（语义化）→ 布局定位 → 字体排版 → 视觉装饰（背景/边框/圆角/阴影）→ 交互状态 → 响应式 → 动效（最后加，有说明才加）\n</实现流程>\n\n<处理规则>\n设计值无法对应项目已有变量时，命名语义化 CSS 变量（如 --color-brand-primary），不写无意义魔法值；标注不清处给出合理推测值并请用户确认；与设计意图有出入时主动说明差异与原因。\n\n<还原度自检>\n关键尺寸一致（容忍 1~2px）；字体颜色一致；主要断点无错位；可交互元素有状态反馈；语义化 HTML（按钮用 button、链接用 a）；图片有 alt。\n\n输出完整可运行代码块（默认单文件 HTML，可按用户技术栈输出组件）。除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'frontend-design-pro',
    name: '前端设计提升',
    description: '用专业设计规范与反模式清单提升 UI 代码的设计质量',
    icon: '✨',
    tags: ['设计', '前端'],
    systemPrompt:
      '你是前端设计质量提升专家，让 UI 代码与设计产出摆脱「千篇一律的模板感」，主动遵循以下设计规范并指出反模式。\n\n<设计规范>\n- 字体：选择有个性的字体（如 Geist、Instrument Serif、DM Sans、Sora），建立比例系统（1.25 或 1.333）；避免 Arial、Inter、system-ui 等通用默认；同页面不超过 2 个字体族\n- 色彩：用 OKLCH 色彩空间定义颜色；中性色永远带色调（暖灰/冷灰）；暗色模式背景用 #0f0f0f 而非纯黑；禁止彩色背景上放灰色文字、禁止纯黑纯灰\n- 空间：4px 或 8px 基础间距系统；用留白创造呼吸感；正文宽 65ch、宽容器 1280px；禁止随意 padding 数值（13px、22px）\n- 动效：缓动用 cubic-bezier(0.16, 1, 0.3, 1)；微交互 100~200ms、页面过渡 300~500ms；尊重 prefers-reduced-motion；禁止 bounce/elastic 缓动、禁止超过 600ms 的动画\n- 交互：focus 状态清晰可见（不删 outline）；加载用 skeleton 优于 spinner；错误信息具体可操作（「邮箱格式不正确」而非「输入有误」）；禁用状态要说明原因\n- UX 文案：按钮动词开头（「保存更改」而非「确认」）；空态说明原因+下一步；错误提示说人话\n</设计规范>\n\n<工作方式>\n生成或修改 UI 代码时自动应用上述规范；发现用户代码有反模式时简短指出；设计建议必须落地到具体代码。支持以下指令：审查（audit，查无障碍/性能/响应式问题）、评审（critique，看层次与清晰度）、打磨（polish，发布前终稿）、化繁为简（distill）、色彩（colorize）、动效（animate）、更大胆（bolder）、更沉稳（quieter）。审查类输出 3~5 个具体问题（带组件名/位置）；修改类输出完整代码并说明改动点。\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'social-media-operator',
    name: '自媒体运营',
    description: '小红书、公众号、抖音与私域的运营策略、爆款文案与数据诊断方法',
    icon: '📢',
    tags: ['营销', '社媒'],
    systemPrompt:
      '你是一位自媒体运营全能助手，覆盖小红书、公众号、抖音与私域流量的运营方法论，基于用户提供的产品/账号信息输出可执行方案。\n\n<小红书>\n标题公式：数字+痛点+承诺、疑问+悬念、对比+惊喜。正文用 AIDA：开头痛点抓注意力 → 独特视角引兴趣 → 成果激发欲望 → 引导互动。标签策略：1 个大流量标签 + 2~3 个垂直标签 + 2~3 个长尾标签。语气亲切真实、像闺蜜推荐。\n\n<公众号>\n10w+ 结构：黄金开头（痛点切入/数据震撼/故事开头）→ 金字塔正文（结论先行、3~5 个分论点各配案例数据）→ 结尾 CTA（关注/互动/转发）。选题四维：热点+垂直、痛点+解决、反差+认知、情感+共鸣。标题公式：[数字]个[方法]帮[人群]解决[痛点] 等变体。\n\n<抖音/短视频>\n脚本结构：开头 3 秒钩子 → 分点核心内容 → 行动号召；每镜头标注画面、台词、时长、BGM 建议。算法核心指标按权重：完播率 > 互动率（评论>分享>点赞）> 关注转化 > 复播。提升完播：开头必有钩子、每 5 秒一个信息点、结尾留悬念、新手控制 15~30 秒。\n\n<私域>\n朋友圈每天 3~5 条，内容配比 40% 价值输出 + 30% 生活分享 + 20% 互动 + 10% 软性推广；黄金时段 7-8 点、12-13 点、18-19 点、21-22 点。转化路径：公域引流（钩子设计）→ 加好友（欢迎语）→ 打标签分层 → 朋友圈种草 → 私聊转化 → 复购裂变。\n\n<内容日历与数据>\n周更节奏参考：干货/故事/干货/互动/软广/生活/复盘；月度规划：品牌建设 → 用户互动 → 产品种草 → 转化收口。数据诊断：确定目标指标（涨粉/曝光/转化）→ 拆解影响因素 → 给出 A/B 测试建议 → 复盘迭代。\n\n工作流程：识别平台 → 理解目标（涨粉/带货/品牌/互动）→ 选合适方法 → 输出具体可执行方案。所有交付物在回复中以 Markdown 输出。\n\n除非用户另行要求，一律用中文回答。',
  },
  {
    id: 'content-hunter',
    name: '内容捕手',
    description: '基于用户提供的热门内容数据做爆款要素、趋势与选题分析',
    icon: '🎯',
    tags: ['营销', '内容'],
    systemPrompt:
      '你是热门内容分析专家（内容捕手），基于用户提供的热门内容数据或截图（来自小红书、抖音、B站等平台），做爆款要素拆解、趋势归纳与选题结构建议。你不抓取任何平台，只分析用户提供的资料。\n\n<输入形态>\n用户提供内容清单（标题、作者、点赞/收藏/评论/播放等热度数据、话题标签、内容简介）或截图文字描述；信息不全时基于已有字段分析并说明局限。\n\n<分析方法论>\n1. 逐条建档：为每条内容归纳「标题 | 热度 | 一句话内容总结」\n2. 爆款要素拆解：标题套路（数字/悬念/对比/痛点）、开头钩子类型、内容结构（分点/故事/清单）、话题标签组合、情绪价值（共鸣/好奇/实用）\n3. 趋势归纳：按主题分类统计，指出高频话题、共性结构、平台差异\n4. 选题建议：从爆款规律提炼 5~8 个用户账号可复用的选题方向，每个附理由\n5. 结构模板：输出 1~2 套可套用的内容框架（标题公式 + 正文骨架 + 标签组合）\n</分析方法论>\n\n<汇报输出>\n1. 热门内容 TOP 榜（按平台分类，每条含标题、热度、内容总结）\n2. 各平台趋势 + 整体趋势\n3. 爆款要素分析\n4. 选题建议与内容模板\n\n除非用户另行要求，一律用中文回答。',
  },
]

/* ==========================================================================
   GitHub 技能链接安装：粘贴 GitHub 链接把仓库中的技能（SKILL.md）装成智能体
   --------------------------------------------------------------------------
   - 纯函数 + async fetch，无 Vue 依赖；统一走 api.github.com（响应带 CORS 头，
     浏览器可直连；携带 Bearer Token 可访问私有仓库）
   - GitHub Token 仅保存在本机 localStorage，用于访问私有仓库
   ========================================================================== */

/** GitHub 技能链接解析结果 */
export interface ParsedGithubSkillUrl {
  owner: string
  repo: string
  /** 分支名；仓库根链接未携带分支时为空串（走仓库默认分支） */
  branch: string
  /** 仓库内路径（无首尾斜杠）；仓库根链接为空串 */
  path: string
  /** 链接形态：file = 直接指向 SKILL.md；dir = 技能目录；root = 仓库根 */
  kind: 'file' | 'dir' | 'root'
}

/** 从技能包（GitHub 链接 / ZIP 文件）解析出的技能定义（可直接作为自定义智能体入参） */
export interface InstalledSkillLike {
  name: string
  description: string
  systemPrompt: string
  /** 技能目录名（SKILL.md 所在目录；仓库根 / 压缩包根级时回退来源名） */
  skillDir: string
}

/** 从 GitHub 拉取并解析后的技能定义 */
export interface GithubSkill extends InstalledSkillLike {
  owner: string
  repo: string
}

/** GitHub Token 在 localStorage 中的持久化 key */
const GITHUB_TOKEN_KEY = 'mr-huang-agent:github-token'
/** GitHub REST API 地址 */
const GITHUB_API_ORIGIN = 'https://api.github.com'
/** SKILL.md 大小上限（100KB），超限拒绝安装 */
const MAX_SKILL_MD_BYTES = 100 * 1024
/** 描述超长时的截断长度 */
const MAX_DESCRIPTION_LENGTH = 60

/** 读取本机保存的 GitHub Token；localStorage 不可用时返回空串 */
export function getGithubToken(): string {
  try {
    return localStorage.getItem(GITHUB_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 保存 / 清除（传空串）本机 GitHub Token；持久化失败时静默降级 */
export function setGithubToken(token: string): void {
  const value = token.trim()
  try {
    if (value) localStorage.setItem(GITHUB_TOKEN_KEY, value)
    else localStorage.removeItem(GITHUB_TOKEN_KEY)
  } catch {
    // 忽略持久化失败（如隐私模式下存储不可用）
  }
}

/** URL 路径逐段解码（技能目录可能是中文名；单段解码失败时保留原文） */
function decodePathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
}

/**
 * 解析 GitHub 技能链接并规范化（容忍首尾空格、末尾斜杠、?query、#hash、
 * 缺协议头自动补 https://、repo 段的 .git 后缀），支持：
 * 1. https://github.com/{owner}/{repo}/blob/{branch}/{path…}/SKILL.md
 * 2. https://github.com/{owner}/{repo}/tree/{branch}/{path…}（技能目录，拉取时列目录找 SKILL.md）
 * 3. https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path…}/SKILL.md
 * 4. 裸 github.com/... 无协议
 * 其余格式返回 null（由调用方给出中文提示）。
 */
export function parseGithubSkillUrl(input: string): ParsedGithubSkillUrl | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const segments = decodePathSegments(url.pathname)

  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const owner = segments[0] ?? ''
    let repo = segments[1] ?? ''
    if (repo.endsWith('.git')) repo = repo.slice(0, -4)
    if (!owner || !repo) return null
    const kindSegment = segments[2] ?? ''
    const rest = segments.slice(3)
    if (kindSegment === 'blob') {
      const branch = rest[0] ?? ''
      const path = rest.slice(1).join('/')
      // blob 链接必须指向 SKILL.md 文件
      if (!branch || path.split('/').pop() !== 'SKILL.md') return null
      return { owner, repo, branch, path, kind: 'file' }
    }
    if (kindSegment === 'tree') {
      const branch = rest[0] ?? ''
      if (!branch) return null
      const path = rest.slice(1).join('/')
      // tree 到仓库根（如 /tree/main）按仓库根处理
      return { owner, repo, branch, path, kind: path ? 'dir' : 'root' }
    }
    if (!kindSegment) return { owner, repo, branch: '', path: '', kind: 'root' }
    // releases / issues / commit 等其他页面链接不支持
    return null
  }

  if (url.hostname === 'raw.githubusercontent.com') {
    const owner = segments[0] ?? ''
    const repo = segments[1] ?? ''
    const branch = segments[2] ?? ''
    const path = segments.slice(3).join('/')
    if (!owner || !repo || !branch || path.split('/').pop() !== 'SKILL.md') return null
    return { owner, repo, branch, path, kind: 'file' }
  }

  return null
}

/** GitHub Contents API 目录条目（目录列举返回数组中的单项） */
interface GithubContentsEntry {
  name?: unknown
  type?: unknown
}

/** GitHub Contents API 的文件响应 */
interface GithubContentsFile {
  size?: unknown
  content?: unknown
  encoding?: unknown
}

/** 调 GitHub API 取 JSON；网络异常与常见状态码统一抛中文错误 */
async function requestGithubJson(apiPath: string, token: string | undefined): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let response: Response
  try {
    response = await fetch(`${GITHUB_API_ORIGIN}${apiPath}`, { headers })
  } catch {
    throw new Error('网络请求失败，请检查网络后重试')
  }
  if (response.status === 404) {
    throw new Error('未找到该技能：仓库不存在、链接有误，或为私有仓库且未配置 GitHub Token')
  }
  if (response.status === 403) {
    throw new Error('GitHub 访问受限（可能触发限流），请稍后再试')
  }
  if (!response.ok) {
    throw new Error(`GitHub 请求失败（HTTP ${response.status}），请稍后再试`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('GitHub 返回了无法解析的内容，请稍后再试')
  }
}

/** 仓库内路径逐段重新编码为 URL 路径（中文目录名等） */
function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

/** 组装 contents API 路径（branch 为空时走仓库默认分支） */
function contentsApiPath(owner: string, repo: string, path: string, branch: string): string {
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : ''
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeRepoPath(path)}${ref}`
}

/** 列举仓库目录（返回 name/type 列表）；响应不是目录数组时报错 */
async function listGithubDir(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string | undefined,
): Promise<Array<{ name: string; type: string }>> {
  const data = await requestGithubJson(contentsApiPath(owner, repo, path, branch), token)
  if (!Array.isArray(data)) {
    throw new Error('无法读取该目录：请确认链接指向技能目录（GitHub 返回的内容不是目录列表）')
  }
  return data.map((entry) => {
    const item = (entry ?? {}) as GithubContentsEntry
    return {
      name: typeof item.name === 'string' ? item.name : '',
      type: typeof item.type === 'string' ? item.type : '',
    }
  })
}

/** base64 → UTF-8 文本（GitHub 返回的 content 含换行需先去除；用 TextDecoder 保证中文不乱码） */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new TextDecoder().decode(bytes)
}

/** 拉取单个 SKILL.md 文件内容；超过 100KB 或内容缺失时抛中文错误 */
async function fetchSkillMdContent(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string | undefined,
): Promise<string> {
  const data = await requestGithubJson(contentsApiPath(owner, repo, path, branch), token)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('未找到该技能：仓库不存在、链接有误，或为私有仓库且未配置 GitHub Token')
  }
  const file = data as GithubContentsFile
  if (typeof file.size === 'number' && file.size > MAX_SKILL_MD_BYTES) {
    throw new Error('SKILL.md 过大（超过 100KB），暂不支持')
  }
  if (typeof file.content !== 'string' || file.encoding !== 'base64') {
    // 文件超过 1MB 时 GitHub 不内联返回 content，统一按过大处理
    throw new Error('SKILL.md 过大（超过 100KB），暂不支持')
  }
  return decodeBase64Utf8(file.content)
}

/** 去掉 YAML 值两侧的成对引号 */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * 解析 SKILL.md 顶部的 YAML frontmatter（--- 包围块），提取 name / description。
 * description 兼容单行（可带引号）与多行块标量（> / >- / | 等，取后续缩进行拼为单行）；
 * 拿不到的字段为空串，由调用方回退。
 */
function parseFrontmatter(text: string): { name: string; description: string; body: string } {
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { name: '', description: '', body: normalized.trim() }
  }
  const endLine = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (endLine === -1) {
    return { name: '', description: '', body: normalized.trim() }
  }
  const frontmatterLines = lines.slice(1, endLine)
  const body = lines.slice(endLine + 1).join('\n').trim()

  const nameLine = frontmatterLines.find((line) => /^name\s*:/.test(line))
  const name = nameLine ? stripQuotes(nameLine.replace(/^name\s*:/, '')) : ''

  const descriptionIndex = frontmatterLines.findIndex((line) => /^description\s*:/.test(line))
  let description = ''
  if (descriptionIndex !== -1) {
    let inline = frontmatterLines[descriptionIndex].replace(/^description\s*:/, '').trim()
    if (/^[>|][+-]?$/.test(inline)) inline = '' // 块标量标记，真实内容在后续缩进行
    const parts = inline ? [stripQuotes(inline)] : []
    for (let index = descriptionIndex + 1; index < frontmatterLines.length; index += 1) {
      const line = frontmatterLines[index]
      // 空行或下一个顶格 key 即块结束
      if (!line || !line.trim() || !/^\s/.test(line)) break
      parts.push(line.trim())
    }
    description = parts.join(' ').replace(/\s+/g, ' ').trim()
  }
  return { name, description, body }
}

/**
 * 从 GitHub 拉取技能并解析为智能体定义：
 * - blob / raw 链接直接取 SKILL.md；tree 目录链接列目录找 SKILL.md（大小写敏感）；
 *   仓库根链接只认根下直接存在 SKILL.md 的单技能仓库，检测到 skills/ 目录时提示
 *   进入具体技能目录（不做递归猜测）
 * - token 用于访问私有仓库；错误统一抛中文信息
 */
export async function fetchSkillFromGithub(url: string, token?: string): Promise<GithubSkill> {
  const parsed = parseGithubSkillUrl(url)
  if (!parsed) {
    throw new Error('无法识别该链接：请粘贴 GitHub 技能目录（含 SKILL.md）或 SKILL.md 文件的链接')
  }
  const { owner, repo, branch, path, kind } = parsed

  let skillMdPath = ''
  if (kind === 'file') {
    skillMdPath = path
  } else if (kind === 'dir') {
    const entries = await listGithubDir(owner, repo, path, branch, token)
    if (!entries.some((entry) => entry.type === 'file' && entry.name === 'SKILL.md')) {
      throw new Error('该目录下未找到 SKILL.md：请确认链接指向技能目录（目录内需包含 SKILL.md）')
    }
    skillMdPath = `${path}/SKILL.md`
  } else {
    const entries = await listGithubDir(owner, repo, '', branch, token)
    if (entries.some((entry) => entry.type === 'file' && entry.name === 'SKILL.md')) {
      skillMdPath = 'SKILL.md'
    } else if (entries.some((entry) => entry.type === 'dir' && entry.name === 'skills')) {
      throw new Error('检测到该仓库的 skills/ 技能目录：请进入具体技能目录后复制链接，再粘贴安装')
    } else {
      throw new Error('暂不支持仓库根链接：请进入包含 SKILL.md 的技能目录后复制链接')
    }
  }

  const raw = await fetchSkillMdContent(owner, repo, skillMdPath, branch, token)
  // 技能目录名：SKILL.md 的上一级目录；仓库根时回退仓库名
  const pathSegments = skillMdPath.split('/')
  const skillDir = pathSegments.length >= 2 ? pathSegments[pathSegments.length - 2] : repo
  const { name, description, systemPrompt } = parseSkillMd(raw, skillDir)
  return { name, description, systemPrompt, skillDir, owner, repo }
}

/**
 * SKILL.md 文本 → 智能体定义（GitHub 链接与 ZIP 上传两条安装路径共享同一份解析）：
 * frontmatter 提取 name / description（描述回退文案、超长 60 字截断）、
 * 正文为空时报错、正文末尾统一追加中文回答约束。
 */
function parseSkillMd(
  text: string,
  fallbackName: string,
  fallbackDescription = '从 GitHub 安装的技能智能体',
): { name: string; description: string; systemPrompt: string } {
  const { name, description, body } = parseFrontmatter(text)
  if (!body) throw new Error('SKILL.md 没有正文内容')

  const displayDescription = description
    ? description.length > MAX_DESCRIPTION_LENGTH
      ? `${description.slice(0, MAX_DESCRIPTION_LENGTH)}…`
      : description
    : fallbackDescription

  // 正文末尾若无中文回答约束则统一追加
  const systemPrompt = /用中文回答/.test(body) ? body : `${body}\n\n除非用户另行要求，一律用中文回答。`
  return { name: name || fallbackName, description: displayDescription, systemPrompt }
}

/* ==========================================================================
   ZIP 技能包上传安装：本地解析技能目录压缩包（内含 SKILL.md），装成智能体；
   兼容 EvoFlow 合集包（manifest.json + skillsets/ 工作流 + skills/*.zip 内嵌技能）
   --------------------------------------------------------------------------
   - 不引入任何依赖，用浏览器原生能力手写 ZIP 解析：尾部回扫 EOCD → 遍历中央
     目录 → 按本地文件头切数据；deflate 用 DecompressionStream('deflate-raw')
     流式解压（Chromium 103+ 原生支持，无需 polyfill）
   - SKILL.md 解析与 GitHub 链接安装完全一致（同一 parseSkillMd）
   - 条目表 / 单条目解压抽成内部函数，外层与内层（合集包 skills/*.zip）共用
   ========================================================================== */

/** ZIP 文件大小上限（10MB），超限拒绝解析 */
const MAX_ZIP_BYTES = 10 * 1024 * 1024
/** EOCD（目录结束记录）签名，小端读出为 0x06054b50 */
const ZIP_EOCD_SIGNATURE = 0x06054b50
/** 中央目录文件头签名，小端读出为 0x02014b50 */
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
/** 本地文件头签名，小端读出为 0x04034b50 */
const ZIP_LOCAL_SIGNATURE = 0x04034b50
/** 中央目录文件头的固定长度（46 字节） */
const ZIP_CENTRAL_HEADER_SIZE = 46
/** 本地文件头的固定长度（30 字节） */
const ZIP_LOCAL_HEADER_SIZE = 30

/** 中央目录中的单个条目（仅提取解析 SKILL.md 所需字段） */
interface ZipEntry {
  /** 完整路径名（目录项已过滤） */
  name: string
  /** 压缩方式：0 = store（原样存储），8 = deflate */
  method: number
  /** 压缩后字节数 */
  compressedSize: number
  /** 本地文件头在 ZIP 中的字节偏移 */
  localOffset: number
}

/** 压缩包文件名 → 安全的技能目录名（去 .zip 后缀，仅保留文字/数字/连字符/下划线） */
function sanitizeZipBaseName(fileName: string): string {
  const safe = fileName
    .replace(/\.zip$/i, '')
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
  return safe || '未命名技能'
}

/** 单技能包导入结果（可直接作为自定义智能体入参） */
export interface ZipSkillImportResult {
  kind: 'skill'
  name: string
  description: string
  systemPrompt: string
  /** 技能目录名（SKILL.md 所在目录；根级时回退压缩包文件名） */
  skillDir: string
}

/** 合集包解出的单个技能（可直接作为自定义技能入参） */
export interface ZipExpertSkill {
  name: string
  description: string
  /** 技能模板（内层 SKILL.md 清洗后的正文） */
  template: string
  /** 技能标识（内层技能目录名 / slug，用于「zip:合集:技能」粒度查重） */
  skillKey: string
}

/** 合集包导入结果：1 个智能体（skillsets 工作流）+ N 个技能（包内 skills/*.zip） */
export interface ZipExpertImportResult {
  kind: 'expert'
  /** 工作流清洗后得到的智能体定义；skillDir = manifest.slug（查重键 zip:{skillDir}） */
  agent: { name: string; description: string; systemPrompt: string; skillDir: string }
  skills: ZipExpertSkill[]
}

/** ZIP 上传导入结果：单技能包 / 合集包，调用方按 kind 分流处理 */
export type ZipImportResult = ZipSkillImportResult | ZipExpertImportResult

/** 合集包 manifest.json 的可识别字段（拿不到或类型不符的字段按空串处理） */
interface ExpertPackageManifest {
  type?: unknown
  slug?: unknown
  displayName?: unknown
  summary?: unknown
}

/**
 * 从 ZIP 原始字节解析出中央目录条目表（外层技能包 / 合集包与内层 skills/*.zip
 * 共用同一份解析）：尾部回扫 EOCD → 遍历中央目录 → 过滤目录项与噪音条目；
 * 拒绝加密与 Zip64；错误统一抛中文信息。
 */
function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // EOCD 固定 22 字节、尾部注释最长 65535 字节：从尾部向前扫描签名
  const eocdFloor = Math.max(0, bytes.length - 22 - 0xffff)
  let eocdOffset = -1
  for (let offset = bytes.length - 22; offset >= eocdFloor; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset === -1) {
    throw new Error('ZIP 文件无效或已损坏：未找到目录结束记录，请重新打包技能目录后重试')
  }
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralOffset = view.getUint32(eocdOffset + 16, true)
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 Zip64 格式的 ZIP 文件，请用标准方式重新打包')
  }

  // 遍历中央目录条目（签名校验防越界错位）
  const entries: ZipEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + ZIP_CENTRAL_HEADER_SIZE > bytes.length ||
      view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE
    ) {
      throw new Error('ZIP 文件无效或已损坏：中央目录读取失败，请重新打包技能目录后重试')
    }
    const flags = view.getUint16(cursor + 8, true)
    if ((flags & 0x0001) !== 0) {
      throw new Error('不支持的加密 ZIP，请上传未加密的 ZIP 文件')
    }
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    // flag bit 11 置位时文件名为 UTF-8；未置位按单字节编码回退（ASCII 文件名两者一致）
    const name = new TextDecoder((flags & 0x0800) !== 0 ? 'utf-8' : 'iso-8859-1').decode(
      bytes.subarray(cursor + ZIP_CENTRAL_HEADER_SIZE, cursor + ZIP_CENTRAL_HEADER_SIZE + nameLength),
    )
    cursor += ZIP_CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength

    if (name.endsWith('/') || name === '__MACOSX' || name.startsWith('__MACOSX/')) continue // 目录项与 macOS 打包噪音
    if (name.split('/').some((segment) => segment.startsWith('.'))) continue // 隐藏文件（.DS_Store 等）
    entries.push({ name, method, compressedSize, localOffset })
  }
  return entries
}

/**
 * 解压单个条目：按本地文件头（30 字节 + 文件名 + 扩展字段）切出压缩数据，
 * deflate 用 DecompressionStream('deflate-raw') 流式解压，store 原样返回。
 */
async function readZipEntryBytes(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const localOffset = entry.localOffset
  if (
    localOffset + ZIP_LOCAL_HEADER_SIZE > bytes.length ||
    view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE
  ) {
    throw new Error('ZIP 文件无效或已损坏：本地文件头读取失败，请重新打包技能目录后重试')
  }
  const localNameLength = view.getUint16(localOffset + 26, true)
  const localExtraLength = view.getUint16(localOffset + 28, true)
  const dataStart = localOffset + ZIP_LOCAL_HEADER_SIZE + localNameLength + localExtraLength
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === 8) {
    // deflate：原生 DecompressionStream('deflate-raw') 流式解压
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  if (entry.method === 0) {
    // store：数据原样存储，直接使用
    return compressed
  }
  throw new Error('不支持的压缩方式（仅支持 store / deflate 的 ZIP）')
}

/** 定位 SKILL.md 条目：优先根级；否则取路径深度最浅的子目录内 SKILL.md */
function findSkillMdEntry(entries: ZipEntry[]): ZipEntry | undefined {
  const root = entries.find((entry) => entry.name === 'SKILL.md')
  if (root) return root
  return entries
    .filter((entry) => entry.name.endsWith('/SKILL.md'))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0]
}

/** manifest 字段读取：仅接受非空字符串，其余（缺失 / 类型不符）按空串处理 */
function manifestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读取根级 manifest.json 并解析；条目不存在或内容损坏（非法 JSON / 非对象）时
 * 返回 null，由调用方回落单技能路径；不向外抛错。
 */
async function readExpertManifest(
  bytes: Uint8Array,
  entries: ZipEntry[],
): Promise<ExpertPackageManifest | null> {
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry) return null
  try {
    const text = new TextDecoder('utf-8').decode(await readZipEntryBytes(bytes, manifestEntry))
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as ExpertPackageManifest) : null
  } catch {
    // manifest 损坏时按不存在处理
    return null
  }
}

/**
 * 合集包工作流文档（skillsets/*.md）→ 智能体提示词的轻量清洗（纯正则）：
 * - 去 frontmatter（复用 parseFrontmatter 的正文提取）
 * - 「你已安装以下 Skill，请按步骤串联使用」安装说明 → 「按以下步骤依次推进」
 * - 删除单独成行的「使用 **技能名** 完成：」包装行（其后 bullets 保留）；
 *   与其他正文同行时仅删除该包装前缀
 * - 结尾不是完整中文句时追加中文回答约束
 */
function cleanSkillsetWorkflow(text: string): string {
  let cleaned = parseFrontmatter(text).body
  cleaned = cleaned.replace(
    /你已安装以下\s*(?:Skill|技能)\s*[，,]?\s*(?:请按步骤串联使用)?/g,
    '按以下步骤依次推进',
  )
  // 单独成行的包装词整行删除（其后 bullets 保留）
  cleaned = cleaned.replace(/^[ \t]*使用[ \t]*\*\*[^*]+\*\*[ \t]*(?:完成|来完成)?[：:]?[ \t]*$/gm, '')
  // 与其他正文同行的包装词只删前缀（含可选的「完成：」尾巴）
  cleaned = cleaned.replace(
    /(^|[-，。；：,;:>])[ \t]*使用[ \t]*\*\*[^*]+\*\*[ \t]*(?:完成|来完成)?[：:]?[ \t]*/gm,
    '$1',
  )
  // 删行后收拢连续空行，首尾去空白
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
  if (!/[。！？!?…”」)\]]\s*$/.test(cleaned)) {
    cleaned = `${cleaned}\n\n除非用户另行要求，一律用中文回答。`
  }
  return cleaned
}

/**
 * 解析合集包（EvoFlow skillhub-expert-package 格式）：
 * - 智能体：skillsets/ 下最浅的第一个 .md 清洗为提示词，名称 / 描述取自 manifest
 * - 技能：skills/*.zip 逐个解开内层 SKILL.md；单个失败（无 SKILL.md / 解压失败 /
 *   超限）跳过不中断，全部失败也不报错（skills 为空数组）
 */
async function parseExpertPackage(
  bytes: Uint8Array,
  entries: ZipEntry[],
  manifest: ExpertPackageManifest,
  fallbackSlug: string,
): Promise<ZipExpertImportResult> {
  const skillDir = manifestString(manifest.slug) || fallbackSlug
  const name = manifestString(manifest.displayName) || skillDir
  // summary 单行化后超长 60 字截断，缺失时用回退文案
  const summary = manifestString(manifest.summary).replace(/\s+/g, ' ')
  const description = summary
    ? summary.length > MAX_DESCRIPTION_LENGTH
      ? `${summary.slice(0, MAX_DESCRIPTION_LENGTH)}…`
      : summary
    : '从合集包导入的智能体'

  // 工作流文档：skillsets/ 下路径深度最浅的第一个 .md
  const workflowEntry = entries
    .filter((entry) => entry.name.startsWith('skillsets/') && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0]
  if (!workflowEntry) {
    throw new Error('合集包中未找到工作流文档：skillsets/ 目录应包含 .md 文件')
  }
  const workflowBytes = await readZipEntryBytes(bytes, workflowEntry)
  if (workflowBytes.byteLength > MAX_SKILL_MD_BYTES) {
    throw new Error('工作流文档过大（超过 100KB），暂不支持')
  }
  const systemPrompt = cleanSkillsetWorkflow(new TextDecoder('utf-8').decode(workflowBytes))

  const skills: ZipExpertSkill[] = []
  const innerZips = entries
    .filter((entry) => /^skills\/[^/]+\.zip$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of innerZips) {
    const zipBase = entry.name.replace(/^skills\//i, '').replace(/\.zip$/i, '')
    // 内层失败跳过，不影响其余技能与智能体导入
    const skill = await parseInnerSkillZip(bytes, entry, zipBase).catch(() => null)
    if (skill) skills.push(skill)
  }
  return { kind: 'expert', agent: { name, description, systemPrompt, skillDir }, skills }
}

/**
 * 解开内层技能 zip（合集包 skills/ 下的条目）为技能条目：
 * 找 SKILL.md（根级或最浅层）→ 与外层一致的 parseSkillMd；
 * skillKey = 内层 SKILL.md 所在目录名，根级时回退 zip 文件名（即技能 slug）。
 */
async function parseInnerSkillZip(
  outerBytes: Uint8Array,
  entry: ZipEntry,
  zipBase: string,
): Promise<ZipExpertSkill> {
  const innerBytes = await readZipEntryBytes(outerBytes, entry)
  const innerEntries = readZipEntries(innerBytes)
  const skillMd = findSkillMdEntry(innerEntries)
  if (!skillMd) throw new Error(`内层 ZIP（${zipBase}.zip）中未找到 SKILL.md，已跳过`)

  const plain = await readZipEntryBytes(innerBytes, skillMd)
  if (plain.byteLength > MAX_SKILL_MD_BYTES) {
    throw new Error(`内层 SKILL.md（${zipBase}）过大（超过 100KB），已跳过`)
  }
  const segments = skillMd.name.split('/')
  const innerDir = segments.length >= 2 ? segments[segments.length - 2] : ''
  const { name, description, systemPrompt } = parseSkillMd(
    new TextDecoder('utf-8').decode(plain),
    innerDir || zipBase,
    '从合集包导入的技能',
  )
  return { name, description, template: systemPrompt, skillKey: innerDir || zipBase }
}

/**
 * 解析 ZIP 上传文件为导入结果（判别联合，调用方按 kind 分流）：
 * 1. 尾部回扫 EOCD → 遍历中央目录 → 过滤噪音条目；拒绝加密与 Zip64
 * 2. 合集包检测：根级 manifest.json 有效且 type=skillhub-expert-package（或无
 *    type 但存在 skillsets/ 条目）→ 1 个智能体 + 包内全部技能；manifest 损坏回落单技能
 * 3. 单技能包：定位 SKILL.md（优先根级，否则最浅子目录）解压，UTF-8 解码后走与
 *    GitHub 安装一致的 parseSkillMd；错误统一抛中文信息
 */
export async function parseSkillZip(file: File): Promise<ZipImportResult> {
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > MAX_ZIP_BYTES) {
    throw new Error('ZIP 文件过大（超过 10MB），暂不支持')
  }
  const bytes = new Uint8Array(buffer)
  const entries = readZipEntries(bytes)

  // 合集包检测：manifest 类型匹配时走合集路径，否则回落单技能路径
  const manifest = await readExpertManifest(bytes, entries)
  const manifestType = manifestString(manifest?.type)
  if (
    manifest &&
    (manifestType === 'skillhub-expert-package' ||
      (manifestType === '' && entries.some((entry) => entry.name.startsWith('skillsets/'))))
  ) {
    return parseExpertPackage(bytes, entries, manifest, sanitizeZipBaseName(file.name))
  }

  // —— 单技能包路径（与合集包无关的普通技能目录压缩包）——
  const target = findSkillMdEntry(entries)
  if (!target) {
    throw new Error(
      'ZIP 中未找到 SKILL.md（技能包应包含 SKILL.md 文件；若是技能合集包，请确认包内含 manifest.json 与 skillsets/ 目录）',
    )
  }

  const plain = await readZipEntryBytes(bytes, target)
  if (plain.byteLength > MAX_SKILL_MD_BYTES) {
    throw new Error('SKILL.md 过大（超过 100KB），暂不支持')
  }

  // 技能目录名：SKILL.md 的上一级目录；根级时回退压缩包文件名（仅取安全字符）
  const segments = target.name.split('/')
  const skillDir = segments.length >= 2 ? segments[segments.length - 2] : sanitizeZipBaseName(file.name)
  const { name, description, systemPrompt } = parseSkillMd(
    new TextDecoder('utf-8').decode(plain),
    skillDir,
    '从 ZIP 导入的技能智能体',
  )
  return { kind: 'skill', name, description, systemPrompt, skillDir }
}
