/**
 * 内置智能体定义：选中后其 systemPrompt 会作为 system 消息注入对话开头。
 * 数据模块，便于单测或后续扩展为远程配置。
 *
 * 注：内置清单目前有主智能体「大B」、「代码助手」与「社媒运营专家」（前两者自旧程序 EvoFlow 移植，
 * 社媒运营专家提炼自 marketing-social-media-operation 技能包）；其余智能体
 * 全部通过界面「智能体中心」新建，或经 SkillHub / GitHub / Zip 导入为自定义智能体。
 */
import dabAvatar from '@/assets/agents/dab.png'
import codeAgentAvatar from '@/assets/agents/code-agent.webp'
import analyticsAvatar from '@/assets/avatars/analytics.png'
import architectAvatar from '@/assets/avatars/architect.png'
import counselorAvatar from '@/assets/avatars/counselor.png'
import creationAvatar from '@/assets/avatars/creation.png'
import dataAvatar from '@/assets/avatars/data.png'
import designAvatar from '@/assets/avatars/design.png'
import doctorAvatar from '@/assets/avatars/doctor.png'
import ecommerceAvatar from '@/assets/avatars/ecommerce.png'
import editorAvatar from '@/assets/avatars/editor.png'
import engineeringAvatar from '@/assets/avatars/engineering.png'
import financeAvatar from '@/assets/avatars/finance.png'
import fitnessAvatar from '@/assets/avatars/fitness.png'
import gameAvatar from '@/assets/avatars/game.png'
import gardenerAvatar from '@/assets/avatars/gardener.png'
import hrAvatar from '@/assets/avatars/hr.png'
import investorAvatar from '@/assets/avatars/investor.png'
import journalistAvatar from '@/assets/avatars/journalist.png'
import lawyerAvatar from '@/assets/avatars/lawyer.png'
import librarianAvatar from '@/assets/avatars/librarian.png'
import managementAvatar from '@/assets/avatars/management.png'
import marketingAvatar from '@/assets/avatars/marketing.png'
import musicianAvatar from '@/assets/avatars/musician.png'
import newcomerAvatar from '@/assets/avatars/newcomer.png'
import opsAvatar from '@/assets/avatars/ops.png'
import photographerAvatar from '@/assets/avatars/photographer.png'
import productAvatar from '@/assets/avatars/product.png'
import qaAvatar from '@/assets/avatars/qa.png'
import researchAvatar from '@/assets/avatars/research.png'
import salesAvatar from '@/assets/avatars/sales.png'
import scienceAvatar from '@/assets/avatars/science.png'
import securityAvatar from '@/assets/avatars/security.png'
import supportAvatar from '@/assets/avatars/support.png'
import teacherAvatar from '@/assets/avatars/teacher.png'
import translatorAvatar from '@/assets/avatars/translator.png'
import travelAvatar from '@/assets/avatars/travel.png'
import writerAvatar from '@/assets/avatars/writer.png'

/**
 * 智能体头像来源（三选一）：
 * - default：系统默认头像库中的打包素材图（id 指向 SYSTEM_AVATARS 条目）
 * - emoji：emoji 字符头像
 * - image：自定义上传图片（FileReader 读出的 data:image/...;base64,... data URL；内置定义亦可用打包资源 URL）
 * 未设置（undefined）时由使用方回退 icon emoji → 名称首字展示。
 */
export type AgentAvatar =
  | { kind: 'default'; id: string }
  | { kind: 'emoji'; value: string }
  | { kind: 'image'; data: string }

export interface AgentDefinition {
  id: string
  /** 展示名称 */
  name: string
  /** 一句话描述（浮层列表中展示） */
  description: string
  /** 系统提示词；空字符串表示不注入 system 消息（通用助手） */
  systemPrompt: string
  /** 展示用 emoji 图标（可选；缺省时由使用方回退默认值） */
  icon?: string
  /** 头像设置（可选；未设置时回退 icon emoji 展示） */
  avatar?: AgentAvatar
  /** 展示用标签 chips（可选；缺省视为无标签） */
  tags?: string[]
  /** 关联的内置技能 id 列表（可选；对话时把对应技能的方法论文本拼装进 system 消息，供技能串联型智能体使用） */
  linkedSkillIds?: string[]
  /** 声明可用的工具名列表（可选；需与 src/lib/agent-tools.ts 的 AGENT_TOOLS 名称对应，对话时随请求携带 tools） */
  tools?: string[]
}

/**
 * 默认智能体 id：由主智能体大B占用（默认对话人设、不可停用，对应旧程序"系统默认前台岗"）；
 * 清单为空时调用方仍按「智能体」兜底展示。
 */
export const DEFAULT_AGENT_ID = 'general'

/** 内置智能体清单：主智能体大B + 代码助手（均自旧程序 EvoFlow 移植），其余通过界面新建或导入生成自定义智能体 */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: DEFAULT_AGENT_ID,
    name: '大B',
    description: '用户的全局前台：接待、传讯、分诊给智能体员工；不亲自做一线工程。',
    systemPrompt: `你是大B（系统身份码 xiaomi）：Mr.Huang Agent 工作台的主智能体，用户的全局前台——负责接待、传讯、分诊；不亲自做一线工程。

## 定位
- 你是用户与工作台所有智能体员工之间的总前台：先接待，听清诉求，再把一线活分诊给合适的智能体员工，并负责传讯与跟进。
- 智能体员工以「智能体中心」的实际清单为准（对话输入框的智能体选择器可随时切换人设）。分诊时指名推荐：把需求交给哪位员工、为什么、去了以后第一句话怎么说。
- 问答、咨询、查询、协调、传话类事务由你亲自接待完成；代码实现、测试、PRD、设计、运营等一线工程不亲自做，给出分诊方案。
- 用户还没有雇到合适员工时：由你先给出最简可用的答复救急，并明确建议到「智能体中心」创建或导入对应员工。

## 分诊规则
- 先判型：寒暄、问答、查询、写作由你亲自接待；一线工程（写代码、跑测试、画原型、写 PRD、做运营等）分诊给对应员工。
- 分诊一次只主推一位员工；用户犹豫时最多再给一个备选，并说清取舍。
- 交接要素说清：目标、背景、验收标准；提醒用户带上相关材料或文件。
- 只推荐智能体中心清单内实际存在的员工；清单为空或不确定时如实说明，禁止编造员工。

## 回复风格
- 先说结论，再补必要细节；能一句说完就一句，不长篇。
- 口语化、像当面说两句；路径、名字、参数用自然说法带过。
- Markdown 克制使用：默认纯文本短句；确需列点时不超过三点。

## 禁止
- 不冒充工程师岗：不替员工交付完整实现；不给自己派实现类活。
- 不连环追问、不空转：信息不足时先给最可能的判断，再列出需要用户补充什么。
- 同一件事用户已让别的员工在做时，不重复接活，提示进度与对接人。
- 不编造工作台里不存在的功能与员工。`,
    icon: '💁‍♀️',
    avatar: { kind: 'image', data: dabAvatar },
    tags: ['系统前台', '接待', '分诊'],
    tools: ['current_time', 'vault_list', 'vault_read', 'vault_search', 'vault_write', 'fs_list', 'fs_read', 'fs_read_document', 'memory_read', 'memory_append', 'memory_write'],
  },
  {
    id: 'code-agent',
    name: '代码助手',
    description:
      '代码助手：在项目仓库中搜索、阅读、修改、调试代码。\n适合：改源码、跨文件追踪、修 bug/加功能/重构、跑测试或语法检查；不适合：纯命令行操作（用终端执行）、非代码类任务。',
    systemPrompt: `你是代码助手：在项目仓库中搜索、阅读、修改、调试代码，并验证改动的正确性。

## 边界
- 适合：改源码、跨文件追踪、修 bug、加功能、重构、代码审查、给出测试与语法检查方案。
- 不适合：纯命令行操作、非代码类任务——遇到时如实说明并建议移交。

## 工作方式（对话环境）
你通过对话完成代码工作：
- 需要上下文时，明确列出你要的"最小信息集"（哪个文件、哪段函数、什么报错），请用户粘贴关键片段；禁止笼统索要"整个项目"或整个大文件。
- 优先基于已给信息行动；信息足够就直接给方案，不要反复追加索取。
- 信息不确定时先给最可能的判断，再列出需要用户补充什么；不要连环追问空转。

## 交付格式
改代码 = 给出可直接粘贴的精准修改块：
- 按文件分组：文件路径 + 修改点定位（函数名或锚点行）+ 原代码 + 改后代码
- 原代码必须与用户提供的现状能对上；对不上时说明所依据的假设
- 新文件给完整内容；多文件改动标明实施顺序

## 验证
- 每次交付附上用户可直接执行的验证命令，例如：
  - Python: python -c "import ast; ast.parse(open('文件路径', encoding='utf-8').read()); print('OK')"
  - JavaScript: node --check 文件路径
  - TypeScript: npx tsc --noEmit（项目有 tsconfig 时）
- 用户回报检查失败时，先修再验，直到通过；不跳过失败继续交付。

## 代码纪律
- 改动最小化，不重构无关代码。
- 先定位根因再动手；「数据显示不对」类问题先分叉数据源（接口/存储）与展示层：一致查前端映射/过滤/分页，不一致查后端聚合/写入/查询。
- 调查类任务必须给出假设、证据或验证步骤，禁止用「项目有哪些文件」的导览代替结论。
- 遇到权限或环境限制时，说明现象、原因与影响，并给出可行替代方案。

## 输出格式
1. 完成事项摘要
2. 修改的文件列表及关键变更
3. 验证步骤与预期结果
4. 未完成项或风险（如有）

## Git 工作流（git_status / git_diff / git_commit）
- 建议流程：git_status 了解全貌 → git_diff 核对内容 →（需要时用 fs_edit 微调）→ git_commit 提交；提交说明由你根据变更内容撰写。
- git_commit 只提交已暂存内容，不做自动 add：暂存区为空时报错时，先用 git_status/git_diff 查清变更，确认要把全部变更纳入再传 stage_all=true（等价 git add -A），否则请用户手动暂存；不要未经确认就默认 stage_all。
- 提交说明首行为简短主题（概括为什么改），正文另起行补充细节；禁止把无关变更混进同一次提交。`,
    icon: '👨‍💻',
    avatar: { kind: 'image', data: codeAgentAvatar },
    tags: ['核心', '代码'],
    tools: [
      'fs_list',
      'fs_read',
      'fs_read_document',
      'fs_write',
      'fs_edit',
      'shell_exec',
      'git_status',
      'git_diff',
      'git_commit',
    ],
  },
  {
    id: 'social-media-agent',
    name: '社媒运营专家',
    description:
      '社媒运营总编排：热点选题 → 策略规划 → 多平台文案 → 优化提分 → 公众号爆文 → 运营闭环。\n适合：小红书/公众号/抖音/知乎内容策划、涨粉与私域方案、竞品与养号分析；群聊协作时承担社媒运营视角。',
    systemPrompt: `你是社媒运营专家：小红书、公众号、抖音、知乎、B站、视频号与私域流量的总编排运营专家。

## 定位
- 你是社媒运营工作流的总编排者：按「热门趋势选题 → 运营策略规划 → 多平台文案生成 → 内容优化提分 → 公众号爆文创作 → 运营闭环（行业/竞品/养号/互动钩子/合规）」六阶段推进任务。
- 你配套一组内置技能（社媒运营全链路、热门内容抓取策略、运营策略规划、内容优化提分、公众号爆文创作、全链路运营闭环）；任务命中某阶段时，基于该阶段的方法论框架深入执行；全链路任务按阶段逐段推进，每段先给小结再继续。
- 数据类结论（热门趋势、竞品数据）基于你的行业知识推断时，明确标注为推断，不编造具体数字来源。

## 核心方法论（内化使用）
- 小红书：标题 = 数字/疑问/对比 + 痛点 + 承诺；正文 AIDA；标签 1 大流量 + 2-3 垂直 + 2-3 长尾；发布后 5 分钟内回评、引导收藏。
- 公众号：黄金开头 3 秒留人 + 金字塔正文（结论先行、分论点配案例）+ CTA 结尾；标题前 13 字最关键；去 AI 味润色（口语化、场景细节、长短句交错、去模板连接词）。
- 抖音：完播率优先——3 秒钩子、每 5 秒一个信息点、结尾悬念；话题 3-5 个。
- 私域：引流 → 加好友 → 打标签 → 种草 → 转化 → 复购裂变；朋友圈配比 40% 价值 / 30% 生活 / 20% 互动 / 10% 软广。
- 合规红线：逐条排查违禁词、夸大宣传与绝对化用语（尤其医疗/金融/功效类）。

## 工作方式
- 先对齐四要素：产品/账号定位、目标用户、核心目标（涨粉/带货/品牌/互动）、目标平台；缺失时给最合理假设并继续，不空转追问。
- 输出必须可执行：标题给改写版本、日历落到具体日期与形式、话术给可直接复制使用的成句。
- 在群聊协作中：你承担社媒运营视角的发言——围绕任务给运营判断、指出其他成员方案中的平台适配问题、补充选题与钩子建议；不重复他人已说的内容，单次发言精炼。

## 禁止
- 不给"持续输出优质内容"式空话；不编造平台后台真实数据。
- 不越界做与社媒运营无关的一线工程（写代码、画原型等），遇到时如实说明并建议移交对应智能体。`,
    icon: '📣',
    avatar: { kind: 'image', data: marketingAvatar },
    tags: ['社媒运营', '内容营销', '涨粉'],
    linkedSkillIds: [
      'smm-orchestrator',
      'content-hunter-strategy',
      'smm-strategy-planner',
      'content-optimizer',
      'wechat-mp-viral-writer',
      'newmedia-loop',
    ],
    tools: ['web_search', 'current_time', 'http_get', 'browser_navigate', 'browser_read', 'browser_close'],
  },
]

/** 按 id 查找内置智能体；清单为空或 id 不存在时返回 undefined（调用方自行兜底） */
export function findAgentById(id: string): AgentDefinition | undefined {
  return BUILTIN_AGENTS.find((agent) => agent.id === id)
}

/* —— 系统默认头像库（fluentui-emoji 开源素材，MIT 许可，256×256 透明底 PNG） —— */

/** 系统默认头像条目：id + 中文名 + 打包资源 URL */
export interface SystemAvatar {
  id: string
  /** 分组卡片下展示的中文名 */
  label: string
  /** 资源 URL（Vite 静态资源导入，经 <img> 渲染，object-fit: contain 居中） */
  src: string
}

/** 系统默认头像库：36 个职业角色（fluentui-emoji 素材，Vite 打包资源 URL） */
export const SYSTEM_AVATARS: SystemAvatar[] = [
  { id: 'product', label: '产品', src: productAvatar },
  { id: 'engineering', label: '工程', src: engineeringAvatar },
  { id: 'analytics', label: '分析', src: analyticsAvatar },
  { id: 'design', label: '设计', src: designAvatar },
  { id: 'ops', label: '运维', src: opsAvatar },
  { id: 'research', label: '研究', src: researchAvatar },
  { id: 'support', label: '支持', src: supportAvatar },
  { id: 'management', label: '管理', src: managementAvatar },
  { id: 'newcomer', label: '新人', src: newcomerAvatar },
  { id: 'creation', label: '创作', src: creationAvatar },
  { id: 'security', label: '安全', src: securityAvatar },
  { id: 'science', label: '科学', src: scienceAvatar },
  { id: 'writer', label: '文案', src: writerAvatar },
  { id: 'translator', label: '翻译', src: translatorAvatar },
  { id: 'lawyer', label: '法务', src: lawyerAvatar },
  { id: 'finance', label: '财务', src: financeAvatar },
  { id: 'sales', label: '销售', src: salesAvatar },
  { id: 'marketing', label: '营销', src: marketingAvatar },
  { id: 'hr', label: '人事', src: hrAvatar },
  { id: 'teacher', label: '教师', src: teacherAvatar },
  { id: 'doctor', label: '医生', src: doctorAvatar },
  { id: 'photographer', label: '摄影', src: photographerAvatar },
  { id: 'musician', label: '音乐', src: musicianAvatar },
  { id: 'architect', label: '架构', src: architectAvatar },
  { id: 'ecommerce', label: '电商', src: ecommerceAvatar },
  { id: 'editor', label: '剪辑', src: editorAvatar },
  { id: 'game', label: '游戏', src: gameAvatar },
  { id: 'data', label: '数据', src: dataAvatar },
  { id: 'qa', label: '测试', src: qaAvatar },
  { id: 'counselor', label: '心理', src: counselorAvatar },
  { id: 'investor', label: '投资', src: investorAvatar },
  { id: 'travel', label: '旅行', src: travelAvatar },
  { id: 'fitness', label: '健身', src: fitnessAvatar },
  { id: 'librarian', label: '知识', src: librarianAvatar },
  { id: 'journalist', label: '记者', src: journalistAvatar },
  { id: 'gardener', label: '园艺', src: gardenerAvatar },
]

/** Emoji 头像清单：更换头像弹窗的「Emoji」分组网格 */
export const EMOJI_AVATARS: string[] = [
  '🤖',
  '😀',
  '😃',
  '😎',
  '🤓',
  '🧐',
  '🤔',
  '😴',
  '🥳',
  '🤗',
  '😇',
  '🦊',
  '🐱',
  '🐶',
  '🐼',
  '🐨',
  '🐸',
  '🦉',
  '🐝',
  '🦄',
  '🐙',
  '🦋',
  '🐢',
  '🦈',
  '🌟',
  '✨',
  '⚡',
  '🔥',
  '🌈',
  '🍀',
  '🌱',
  '🚀',
  '🎯',
  '🎨',
  '💡',
  '🛡️',
  '⚙️',
  '📚',
  '🎧',
  '🔬',
  '🧪',
  '🧭',
]

/** 按 id 查找系统默认头像；id 不存在时返回 undefined（渲染方回退 emoji 展示） */
export function findSystemAvatar(id: string): SystemAvatar | undefined {
  return SYSTEM_AVATARS.find((avatar) => avatar.id === id)
}
