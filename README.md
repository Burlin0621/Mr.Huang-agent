# Mr.Huang Agent · 工作台前端

[![CI](https://github.com/YOUR_USERNAME/mr-huang-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/mr-huang-agent/actions)

> 名称来自项目目录「Mr.Huang Agent」，界面文案全部为中文。
> 当前为 **工程骨架版本（v0.1.0）**：整体布局、导航、路由、响应式与主题系统已就绪，业务功能模块以占位形式呈现，后续迭代再接入。未接入任何真实数据或 mock API。

> 徽章中的 `YOUR_USERNAME` 需替换为你的 GitHub 用户名（见文末「推送到 GitHub」）。

## 项目简介

Mr.Huang Agent 工作台前端是一个基于 Vue 3 + Vite + TypeScript 的中后台工程骨架，内置布局、导航、路由、响应式与明暗主题系统，可作为后续业务模块迭代的基础。工程化配置（ESLint / Prettier / EditorConfig / GitHub Actions CI）已就绪，可直接推送至 GitHub 协作开发。现已支持接入 OpenAI 兼容大模型：设置页可管理多套多厂商模型配置（智谱 GLM、DeepSeek、阿里百炼、Moonshot、火山方舟、OpenAI、Ollama 等，含连接测试），「AI 对话」页提供多轮流式对话（逐 token 渲染、思考过程折叠、可中断），并内置**多工作区会话工作区**：对话之上支持多个工作区（各自独立的一套对话，可新建/切换/重命名/删除），工作区内可新增 / 切换 / 重命名 / 归档 / 恢复 / 删除对话；全部数据持久化到 localStorage（刷新不丢失，含思考过程与错误、已停止标记），任务目标、智能体与模型选择随对话保存并在切换时自动恢复，每个工作区记住自己上次打开的对话。智能体可绑定默认模型，对话中选中即自动切换。

## 技术栈

| 类别 | 选型 |
| --- | --- |
| 框架 | Vue 3（组合式 API，`<script setup lang="ts">`） |
| 构建 | Vite + TypeScript（构建前经 `vue-tsc` 类型检查，0 错误才产出） |
| 路由 | Vue Router（history 模式） |
| 状态 | Pinia |
| 样式 | 自定义 CSS 设计令牌（CSS 变量），不使用任何 UI 组件库与 Tailwind |
| 代码规范 | ESLint（flat config，TS + Vue）+ Prettier + EditorConfig |
| CI | GitHub Actions（push / PR 到 main 时执行 lint + build） |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器（默认 http://localhost:5173）
npm run dev

# 3. 类型检查 + 生产构建（输出到 dist/）
npm run build

# 4. 本地预览生产构建
npm run preview

# 附加：校验开发服务器是否返回 200 且包含应用挂载点
npm run verify:dev
```

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run dev` | 启动开发服务器（默认 http://localhost:5173） |
| `npm run build` | 类型检查（vue-tsc）+ 生产构建（输出到 dist/） |
| `npm run preview` | 本地预览生产构建 |
| `npm run lint` | ESLint 检查（要求 0 error 0 warning） |
| `npm run lint:fix` | ESLint 检查并自动修复可修复问题 |
| `npm run format` | Prettier 格式化 `src` 下 `.ts` / `.vue` / `.css` |
| `npm run verify:dev` | 校验开发服务器返回 200 且包含应用挂载点 |

## 调试入口

无需记忆命令：在项目根目录双击 **`启动调试.bat`** 即可启动开发服务器，浏览器会自动打开 http://localhost:5173。

- 首次运行会自动安装依赖（需已安装 Node.js / npm，未检测到 npm 时脚本会给出安装地址）；
- 两个 .bat 脚本均使用纯 ASCII 内容，提示信息为英文（`[INFO]` / `[ERROR]`），以避免 cmd 编码乱码问题；
- 关闭该命令行窗口即停止调试服务器。

### 桌面窗口（免打包调试）

想以"桌面程序"的方式调试而**不做任何打包封装**：双击项目根目录的 **`启动桌面版.bat`**（或运行 `npm run desktop`）即可弹出一个独立的 Electron 桌面窗口，加载的仍是 Vite dev server（http://localhost:5173），代码热更新照常生效。

- 桌面窗口为无边框样式，顶栏可拖拽移动窗口，右上角为系统窗口控制按钮；
- 首次运行会自动安装依赖（含 `electron` / `concurrently` / `wait-on`）；
- 若 5173 端口已有 dev server 在跑（例如先用 `启动调试.bat` 启动过），桌面窗口会直接复用它；
- 关闭桌面窗口即同时停止 Vite 与 Electron（`concurrently -k`）；
- 该模式下 `src/lib/desktop-bridge.ts` 的桥接真实可用：`window.mrHuangDesktop.selectFolder()` 会弹出系统目录选择对话框（`electron/preload.cjs` + `electron/main.cjs` 的 IPC `select-folder` 实现），「工作区关联文件夹」可以直接选本机目录，无需手动粘贴路径。

## 目录结构

```
Mr.Huang Agent/
├─ index.html                  # 入口 HTML（含首屏防闪白的主题初始化脚本）
├─ package.json
├─ vite.config.ts              # Vite 配置（@ 别名指向 src）
├─ tsconfig.json
├─ eslint.config.js            # ESLint flat config（TypeScript + Vue）
├─ .prettierrc                 # Prettier 配置
├─ .prettierignore             # Prettier 忽略清单
├─ .editorconfig               # 编辑器基础格式统一
├─ .vscode/                    # 推荐插件与「保存即格式化 / ESLint 校验」配置
├─ .github/workflows/ci.yml    # GitHub Actions：push/PR 到 main 执行 lint + build
├─ README.md
├─ scripts/
│  └─ verify-dev.mjs           # dev server 自检脚本（200 + 挂载点）
└─ src/
   ├─ main.ts                  # 应用入口：装配 Pinia / Router / 全局样式
   ├─ App.vue                  # 根组件，渲染主布局
   ├─ vite-env.d.ts
   ├─ layouts/
   │  └─ MainLayout.vue        # 侧边栏 + 顶栏 + 主内容区（含窄屏抽屉）
   ├─ views/                   # 页面级组件（当前均为占位）
   │  ├─ DashboardView.vue     # /        工作台（欢迎区 + 统计卡片 + 建设提示）
   │  ├─ ChatView.vue          # /chat    AI 对话（多工作区会话工作区 + 多轮流式对话）
   │  ├─ TasksView.vue         # /tasks   任务中心（空状态）
   │  ├─ DataCenterView.vue    # /data    数据中心（空状态）
   │  └─ SettingsView.vue      # /settings 设置（主题选择可交互）
   ├─ components/
   │  ├─ AppIcon.vue           # 内置 SVG 图标组件（无第三方图标库）
   │  ├─ EmptyState.vue        # 空状态（占位插画 + 文案）
   │  ├─ StatCard.vue          # 统计卡片
   │  ├─ ThemeToggle.vue       # 顶栏三态主题切换按钮
   │  └─ UserAvatar.vue        # 用户头像占位（圆形 + 初始字母 H）
   ├─ router/
   │  └─ index.ts              # history 模式路由 + 面包屑标题元信息
   ├─ stores/
   │  ├─ theme.ts              # 主题 Pinia store（偏好 / 持久化 / 系统监听）
   │  ├─ llm.ts                # 模型配置 Pinia store（多套配置 / localStorage 持久化）
   │  ├─ agents.ts             # 智能体 Pinia store（内置 + 自定义 / 停用 / 覆盖快照）
   │  ├─ skills.ts             # 技能 Pinia store（提示词模板）
   │  ├─ workspaces.ts         # 工作区 Pinia store（多工作区 / 最近对话 / 旧数据迁移）
   │  └─ conversations.ts      # 对话 Pinia store（按工作区分组 / 归档 / localStorage 持久化）
   └─ styles/
      ├─ tokens.css            # 设计令牌：:root 浅色，[data-theme="dark"] 深色
      └─ base.css              # 全局基础样式与通用工具类（卡片/按钮/徽标等）
```

## 页面与路由

| 路径 | 页面 | 当前状态 |
| --- | --- | --- |
| `/` | 工作台 | 欢迎区 + 4 张占位统计卡片 + 「模块建设中」提示 |
| `/chat/:conversationId?` | AI 对话 | 多工作区会话工作区（工作区新建/切换/重命名/删除，各自独立一套对话与归档；对话新增/切换/重命名/归档/恢复/删除，localStorage 持久化，刷新不丢上下文与消息）+ 多轮流式对话（依赖设置页的模型配置；逐 token 渲染、思考过程折叠、可停止）；不带 id 为当前工作区的新对话草稿态 |
| `/agents` | 智能体中心 | 内置 + 自定义智能体管理，支持绑定默认模型（对话中选中即自动切换）；顶栏「技能市场」提供可搜索、可分类筛选的一键安装开源技能（内置精选索引 + GitHub 在线搜索） |
| `/skills` | 技能中心 | 提示词模板管理 |
| `/tasks` | 任务中心 | 空状态占位 |
| `/data` | 数据中心 | 空状态占位 |
| `/settings` | 设置 | 外观（主题选择，与顶栏切换联动）+ 模型接入（多套模型配置管理、连接测试） |

未匹配路径会重定向回 `/`。

## 主题系统

- 设计令牌集中在 `src/styles/tokens.css`：`:root` 定义浅色主题，`[data-theme="dark"]` 覆盖为深色主题。令牌覆盖颜色、圆角、间距、字体、阴影、动效与布局尺寸。
- 主题偏好（`system` / `light` / `dark`）由 Pinia store `src/stores/theme.ts` 统一管理：
  - 默认「跟随系统」，通过 `matchMedia('(prefers-color-scheme: dark)')` 监听系统主题变化并实时生效；
  - 手动选择浅色 / 深色时，通过 `document.documentElement` 的 `data-theme` 属性覆盖系统偏好；
  - 偏好持久化到 `localStorage`（key 为 `mr-huang-agent:theme`）；
  - `index.html` 内置首屏初始化脚本，在应用挂载前设置 `data-theme`，避免刷新时闪屏。
- 顶栏主题按钮为三态循环（跟随系统 → 浅色 → 深色），与设置页的主题选项共用同一 store，自动联动。

## 响应式

- 视口宽度 ≥ 900px：左侧固定侧边栏 + 右侧内容区；
- 视口宽度 < 900px：侧边栏自动收起为抽屉，点击顶栏菜单按钮展开，点击遮罩或切换路由后自动关闭；「AI 对话」页的工作区选择器与会话面板同样收为抽屉（消息区左上角浮动按钮展开）；
- 统计卡片在窄屏下自动降为 2 列 / 1 列，布局不破。

## 本地数据（localStorage）

- key 前缀统一为 `mr-huang-agent:`：
  - `workspaces`（工作区列表）与 `active-workspace`（当前工作区）：每个工作区记录名称、emoji 图标、关联文件夹路径 `folderPath`（'' 表示未关联，桌面封装预留）与「最近打开的对话 id」；
  - `conversations`（全部对话，含所属工作区 id、消息与上下文），写入经 500ms 防抖（流式期间高频更新）；
  - 其余：`llm-configs` / `llm-active`（模型配置）、`custom-agents` / `disabled-agents` / `builtin-overrides`（智能体）、`theme`（主题偏好）。
- 旧版数据自动迁移：仅有历史 `conversations` 数据（无工作区）时，首次打开自动创建「默认工作区」（📁）并归入全部旧对话；旧 `active-conversation` key 读取后即清理，「最近对话」统一记录在工作区的 `lastConversationId`。
- 读取均为防御式（坏数据丢弃/兜底），写入失败（如配额满）静默降级为仅当前会话生效。
- 应用内置 `design-prd-writing` 与 `design-ui-prototype` 两个技能合集包，以及单技能包 `all-platform-video-extract`（zip 随应用打包于 `src/assets/skillhub/`），启动时自动以「手动导入 ZIP」相同的方式导入（合集包：智能体查重键 `zip:{skillDir}`，技能查重键 `zip:{skillDir}:{skillKey}`；单技能包：查重键 `zip:{skillDir}`，仅导入为智能体）。因查重基于 localStorage 中的自定义数据，删除后下次启动会按查重键重新导入；若不想让其再次出现，需一并清空浏览器存储或保留删除后的数据不清理。

## 桌面封装对接（预留）

工作区可关联一个本机文件夹（`folderPath` 字段），为后续用 Electron / Tauri 把本网页封装成桌面程序预留：届时「新建/编辑工作区」里可直接选择系统目录作为工作区（类似 ZCode 打开目录）。

- 契约：封装时通过 preload 在 `window` 上暴露桥接对象 `mrHuangDesktop`，其中 `selectFolder(): Promise<string | null>` 返回所选目录的绝对路径，用户取消返回 `null`（定义见 `src/lib/desktop-bridge.ts`）；
- 纯浏览器环境没有该桥接，只能手动粘贴路径（点「选择…」会轻提示说明）；
- 封装时按契约暴露 `window.mrHuangDesktop.selectFolder` 后，前端「选择…」按钮即刻生效，无需再改前端代码。

Electron 示例（preload + main）：

```ts
// preload.ts —— 暴露桥接到 window
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('mrHuangDesktop', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
})
```

```ts
// main.ts —— 弹出系统目录选择对话框
import { dialog, ipcMain } from 'electron'

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
})
```

## 开发约定

- 组件一律使用组合式 API 与 TypeScript；
- 颜色、间距等一律引用 `src/styles/tokens.css` 中的令牌，禁止在组件里写死颜色值；
- 全局通用样式（页面容器、卡片、按钮、徽标、图标按钮）位于 `src/styles/base.css`；
- 图标为内置 SVG 组件（`src/components/AppIcon.vue`），不依赖第三方图标库；
- 提交前请确保 `npm run lint`（0 error 0 warning）与 `npm run build` 通过，提交信息遵循 Conventional Commits（`feat:` / `fix:` / `chore:` 等）。

## 推送到 GitHub

1. 在 GitHub 上新建一个**空仓库**（不要勾选初始化 README / .gitignore / LICENSE），名称建议为 `mr-huang-agent`；
2. 本地仓库已初始化在 `main` 分支并包含 `v0.1.0` 标签，关联远程后推送即可：

   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/mr-huang-agent.git
   git push -u origin main --tags
   ```

3. 推送后 `.github/workflows/ci.yml` 会在 GitHub Actions 自动执行依赖安装、lint 与 build；
4. 别忘了把 README 顶部 CI 徽章中的 `YOUR_USERNAME` 替换为你的 GitHub 用户名。
