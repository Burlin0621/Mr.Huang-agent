/**
 * 智能体工具 schema 常量（渲染进程侧）：
 * - 供 llm.ts 的 function calling `tools` 参数与 UI 展示使用；
 * - 与 electron/tools.cjs 中的主进程注册表一一对应。
 *
 * ⚠️ 同步义务：.cjs 与 TS 模块无法直接互引（主进程 require 的是 electron/tools.cjs 内
 * 手工复制的同构定义），两边任何 schema/description 变更必须同步修改另一边，
 * 并保持 name 完全一致——name 是渲染进程、LLM 与主进程三方的唯一关联键。
 */

/** 单个工具的 OpenAI function calling 声明（parameters 为简化 JSON Schema） */
export interface AgentToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: 'string' | 'number' | 'boolean'; description: string }>
    required: string[]
  }
}

export type AgentToolName =
  | 'current_time'
  | 'http_get'
  | 'http_post_json'
  | 'browser_navigate'
  | 'browser_read'
  | 'browser_screenshot'
  | 'browser_close'
  | 'web_search'
  | 'web_fetch'
  | 'image_generate'
  | 'vault_list'
  | 'vault_read'
  | 'vault_write'
  | 'vault_search'
  | 'fs_list'
  | 'fs_read'
  | 'fs_read_document'
  | 'fs_write'
  | 'fs_edit'
  | 'shell_exec'
  | 'git_status'
  | 'git_diff'
  | 'git_commit'
  | 'memory_read'
  | 'memory_write'
  | 'memory_append'
  | 'use_skill'
  | 'skill_install'

/** 首批工具 schema（与 electron/tools.cjs 的 TOOL_REGISTRY 保持同步） */
export const AGENT_TOOLS: readonly AgentToolSchema[] = [
  {
    name: 'current_time',
    description: '获取当前的本地日期与时间（含时区与星期）。当回答涉及"现在/今天/最近"等时间信息时使用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'http_get',
    description:
      '发起 HTTP GET 请求抓取网页/接口内容并转为纯文本返回（仅支持 http/https，超时 15 秒，超长内容会截断）。需要读取某个 URL 的内容时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的完整 URL，必须以 http:// 或 https:// 开头' },
      },
      required: ['url'],
    },
  },
  {
    name: 'http_post_json',
    description:
      '向指定 URL 发送 POST 请求（Content-Type: application/json），返回响应文本（仅支持 http/https，超时 15 秒，超长内容会截断）。需要提交 JSON 数据到某个接口时使用；发送前必须先向用户确认目标地址。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL，必须以 http:// 或 https:// 开头' },
        body: { type: 'string', description: '要发送的 JSON 字符串（必须是合法 JSON）' },
      },
      required: ['url', 'body'],
    },
  },
  {
    name: 'browser_navigate',
    description:
      '用内置无头浏览器打开指定网页（仅支持 http/https，操作超时 30 秒）。要浏览动态渲染的网页内容时先调用本工具，再用 browser_read 读取。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整 URL，必须以 http:// 或 https:// 开头' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_read',
    description:
      '读取内置浏览器当前打开页面的内容：页面标题 + 正文纯文本（已剥离脚本、导航、页脚等噪音）+ 链接列表，超长内容截断。必须先用 browser_navigate 打开页面。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_screenshot',
    description:
      '对内置浏览器当前打开的页面截取全页 PNG，并把截图作为图片提供给模型查看，用于 UI 走查、版式核对等视觉场景。必须先调用 browser_navigate 打开页面。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_close',
    description:
      '关闭内置浏览器并释放资源。完成网页浏览任务后调用，或浏览器状态异常时调用以便下次重新启动。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'web_search',
    description:
      '联网关键词搜索，返回结构化结果列表（标题/摘要/链接/来源/日期），适合热点、资讯、时事类检索；查"最近/今天/最新"的内容时优先使用本工具而不是用 http_get 猜网址。依赖智谱开放平台 API Key（baseUrl 为 open.bigmodel.cn 的模型配置）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果条数（1-50，默认 10）' },
        recency: {
          type: 'string',
          description: '时间范围过滤："oneDay"|"oneWeek"|"oneMonth"|"noLimit"，默认 "oneWeek"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      '联网抓取指定 URL 的网页并转为可读文本返回（自动跟随重定向，超时 20 秒，响应上限 2MB，输出截断）。HTML 页面会剥离 script/style 与标签并提取标题与正文文本；txt/json/md 等纯文本内容原样返回。需要完整阅读某个网页/文档链接的内容时优先使用本工具。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的完整 URL，必须以 http:// 或 https:// 开头' },
      },
      required: ['url'],
    },
  },
  {
    name: 'image_generate',
    description:
      '调用智谱 GLM-Image 生成一张图片，返回图片 URL。适合公众号封面、文章插图、配图等场景。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（最大 1000 字符，超出会自动截断）' },
        size: {
          type: 'string',
          description:
            '图片尺寸"宽x高"（如 1280x1280），宽高均在 512-2048 之间且为 32 的整数倍，默认 "1280x1280"（推荐 1728x960 / 1472x1088 / 1280x1280）',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'vault_list',
    description:
      '列出当前工作区关联的 Obsidian 笔记文件夹（vault）中的全部 .md 笔记（扁平清单：相对路径/文件名/大小/修改时间，跳过隐藏目录）。需要浏览笔记有哪些、决定读哪篇时使用。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: 'vault 根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        subPath: { type: 'string', description: '可选，限定列出的子目录（vault 内相对路径）' },
      },
      required: [],
    },
  },
  {
    name: 'vault_read',
    description:
      '读取当前工作区关联 vault 中的一篇 .md 笔记的完整内容（单篇上限 2MB，超长截断）。需要查看笔记正文时使用。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: 'vault 根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '笔记在 vault 内的相对路径（以 / 分隔，如「日记/2026-09-27.md」）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'vault_write',
    description:
      '向当前工作区关联的 vault 写入一篇 .md 笔记（自动创建父目录；默认不覆盖已存在文件，需要覆盖时显式传 overwrite=true）。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: 'vault 根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '笔记在 vault 内的相对路径（以 / 分隔，如「AI 笔记/2026-09-27.md」）' },
        content: { type: 'string', description: '笔记正文（Markdown 文本）' },
        overwrite: { type: 'boolean', description: '目标笔记已存在时是否覆盖，默认 false' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'vault_search',
    description:
      '在当前工作区关联的 vault 中全文检索关键词（大小写不敏感按行匹配，返回笔记路径/行号/上下文片段，最多 100 条）。需要按内容查找笔记时使用。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: 'vault 根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fs_list',
    description:
      '列出当前工作区关联文件夹中的全部文件（不限扩展名，扁平清单：相对路径/大小/修改时间，跳过隐藏目录；可用 subPath 限定子目录、ext 按扩展名过滤）。需要浏览工作区有哪些文件、决定读哪个时先调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        subPath: { type: 'string', description: '可选，限定列出的子目录（工作区内相对路径）' },
        ext: { type: 'string', description: '可选，按扩展名过滤，如 "docx" 或 ".docx"（大小写不敏感）' },
      },
      required: [],
    },
  },
  {
    name: 'fs_read',
    description:
      '读取当前工作区关联文件夹中文本类文件的完整内容（utf-8，GBK 自动兜底；支持 .md .txt .json .csv .xml .html .yml .js .ts .py .css 等文本扩展名，单文件上限 2MB，超长截断）。.docx/.pdf 请改用 fs_read_document。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '文件在工作区内的相对路径（以 / 分隔，如「docs/说明.md」）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_read_document',
    description:
      '读取当前工作区关联文件夹中的 .docx 或 .pdf 文档并转为纯文本返回（上限 20MB，超长截断）。需要读取 Word 文档或 PDF 的正文内容时使用；.doc/.xls/.ppt 等旧格式不支持，请先另存为新格式。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '文档在工作区内的相对路径（以 / 分隔，如「合同/协议.docx」）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_write',
    description:
      '在工作区关联文件夹内写入文本文件（utf-8，自动创建父目录；仅支持 .md .txt .json .csv .xml .html .yml .js .ts .py .css 等文本扩展名，单文件上限 2MB）。默认目标已存在时拒绝，需要覆盖时显式传 overwrite=true；仅允许工作区内相对路径，禁止路径穿越。新建或覆盖文件时使用；修改已有文件的局部内容优先用 fs_edit。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '文件在工作区内的相对路径（以 / 分隔，如「docs/说明.md」）' },
        content: { type: 'string', description: '要写入的完整文本内容（utf-8）' },
        overwrite: { type: 'boolean', description: '目标文件已存在时是否覆盖，默认 false（不覆盖则报错）' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fs_edit',
    description:
      '对工作区内已有的文本文件做精准替换编辑：old_string 必须在文件中恰好出现一次（replace_all=true 时替换全部出现），否则报错并需调整后重试。替换后原子写回（utf-8，GBK 兜底读取）。仅支持文本类扩展名、单文件 2MB 上限、仅允许工作区内相对路径。修改已有文件的局部内容时优先使用本工具，而不是用 fs_write 整文件重写。',
    parameters: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '文件在工作区内的相对路径（以 / 分隔，如「docs/说明.md」）' },
        old_string: { type: 'string', description: '要被替换的原文片段（必须与文件内容精确匹配，含缩进与换行）' },
        new_string: { type: 'string', description: '替换后的新文本（删除内容时传空字符串）' },
        replace_all: { type: 'boolean', description: '是否替换全部出现（默认 false，仅允许恰好出现一次）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'shell_exec',
    description:
      '在工作区文件夹内执行一条 shell 命令（Windows cmd）并返回 stdout/stderr/退出码。适合运行构建、测试、脚本、git 等命令。每次只执行一条命令，不支持交互式输入；谨慎使用删除、格式化等破坏性命令，破坏性操作需先征得用户同意。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（单条，不支持交互式输入）' },
        cwd: {
          type: 'string',
          description: '可选，工作目录（工作区内相对路径，缺省为工作区根；禁止 ../ 或绝对路径逃逸）',
        },
        timeout_ms: {
          type: 'number',
          description: '可选，超时毫秒（1000–300000，默认 60000），超时将终止整个进程树',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_status',
    description:
      '查看工作区 git 仓库状态（只读）：当前分支、与上游的领先/落后、已暂存/未暂存/未跟踪文件清单（结构化）。建议在 git_diff / git_commit 之前先调用本工具了解全貌。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_diff',
    description:
      '查看工作区 git 仓库的变更内容（只读，逐文件 unified diff）：默认比较工作区 vs 暂存区；staged=true 比较暂存区 vs HEAD；可用 path 限定单个文件（工作区内相对路径）。提交前建议先用本工具核对要提交的内容。',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: '可选，true 时查看暂存区相对 HEAD 的 diff（默认 false：工作区相对暂存区）' },
        path: { type: 'string', description: '可选，限定单个文件（工作区内相对路径，如「src/lib/llm.ts」）' },
      },
      required: [],
    },
  },
  {
    name: 'git_commit',
    description:
      '提交当前 git 仓库的暂存区内容（写操作，需确认）：只提交已暂存的变更，不做自动 add。暂存区为空时报错——此时先用 git_status / git_diff 查看变更，确认要把全部变更纳入时再传 stage_all=true（等价 git add -A 后提交），否则让用户手动暂存。建议流程：git_status → git_diff 核对 →（需要时用 fs_edit 微调）→ git_commit；提交说明（message）由你根据变更内容撰写，首行为简短主题，正文另起行补充细节。',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '提交说明：首行为主题（简洁概括本次变更），可另起行写正文细节',
        },
        stage_all: {
          type: 'boolean',
          description: '可选，true 时先执行 git add -A 把工作区全部变更纳入暂存区再提交（默认 false：只提交已暂存内容）',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'memory_read',
    description:
      '读取当前工作区的长期记忆全文（Markdown：用户偏好、项目约定、经验教训等跨会话沉淀）。回答前需要回顾既有记忆，或写入记忆后核对结果时使用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'memory_write',
    description:
      '整篇覆盖当前工作区的长期记忆（用户偏好、项目约定、经验教训等跨会话沉淀）。仅在需要大幅重组/清理记忆时使用；日常沉淀优先用 memory_append。计划模式下会被拦截。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆全文（Markdown），将整篇替换现有记忆；单文件上限 64KB' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_append',
    description:
      '维护当前工作区的长期记忆（用户偏好、项目约定、经验教训）；涉及「记住/以后都/我的习惯是」等表述，或任务结束得出可复用经验时写入。向记忆末尾追加一节，自动加当天日期标题（## YYYY-MM-DD），无需手动拼接时间戳。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要追加的记忆正文（Markdown，一节内容；不要自己写日期标题）' },
      },
      required: ['content'],
    },
  },
  {
    name: 'use_skill',
    description:
      '加载一个技能的完整指令（技能正文为信息性内容，不执行外部操作）。当「可用技能」清单中的某技能与当前任务相关时调用：参数传技能名称或 id，返回该技能的完整指令与脚本清单，之后严格按指令执行并向用户声明正在使用该技能。',
    parameters: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: '技能名称或技能 id（以「可用技能」清单中列出的名称为准）',
        },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'skill_install',
    description:
      '把 GitHub 上的 Agent Skill 技能安装进技能中心（等同用户在界面的技能市场点「安装」）。当用户说「安装 xx 技能 / 装一下 GitHub 上的 xx」时调用：传 GitHub 仓库简写（owner/repo）或指向技能目录/SKILL.md 的完整链接，可选 skillDir 指定仓库内技能目录（多技能仓库必填）。安装成功后技能立即可在技能中心看到，并可用 use_skill 按技能名调用。重复安装会明确提示，不会重复写入。',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'GitHub 仓库简写（如 "anthropics/skills"）或完整 URL（github.com 技能目录 / SKILL.md 文件、raw.githubusercontent.com 链接均可）',
        },
        skillDir: {
          type: 'string',
          description: '可选：仓库内技能目录名（如 "pdf"）。仓库含多个技能时用于定位；缺省时自动探测（仓库根直接含 SKILL.md 的单技能仓库）',
        },
        notes: {
          type: 'string',
          description: '可选：安装备注，会附在技能正文末尾',
        },
      },
      required: ['source'],
    },
  },
] as const

/** 按名称查找工具 schema；未注册返回 undefined */
export function findAgentTool(name: string): AgentToolSchema | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name)
}
