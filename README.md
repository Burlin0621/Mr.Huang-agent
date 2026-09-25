# Mr.Huang Agent · 工作台前端

[![CI](https://github.com/YOUR_USERNAME/mr-huang-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/mr-huang-agent/actions)

> 名称来自项目目录「Mr.Huang Agent」，界面文案全部为中文。
> 当前为 **工程骨架版本（v0.1.0）**：整体布局、导航、路由、响应式与主题系统已就绪，业务功能模块以占位形式呈现，后续迭代再接入。未接入任何真实数据或 mock API。

> 徽章中的 `YOUR_USERNAME` 需替换为你的 GitHub 用户名（见文末「推送到 GitHub」）。

## 项目简介

Mr.Huang Agent 工作台前端是一个基于 Vue 3 + Vite + TypeScript 的中后台工程骨架，内置布局、导航、路由、响应式与明暗主题系统，可作为后续业务模块迭代的基础。工程化配置（ESLint / Prettier / EditorConfig / GitHub Actions CI）已就绪，可直接推送至 GitHub 协作开发。现已支持接入 OpenAI 兼容大模型：设置页可管理多套多厂商模型配置（智谱 GLM、DeepSeek、阿里百炼、Moonshot、火山方舟、OpenAI、Ollama 等，含连接测试），「AI 对话」页提供多轮流式对话（逐 token 渲染、思考过程折叠、可中断）。

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
- 关闭该命令行窗口即停止调试服务器。

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
   │  └─ theme.ts              # 主题 Pinia store（偏好 / 持久化 / 系统监听）
   └─ styles/
      ├─ tokens.css            # 设计令牌：:root 浅色，[data-theme="dark"] 深色
      └─ base.css              # 全局基础样式与通用工具类（卡片/按钮/徽标等）
```

## 页面与路由

| 路径 | 页面 | 当前状态 |
| --- | --- | --- |
| `/` | 工作台 | 欢迎区 + 4 张占位统计卡片 + 「模块建设中」提示 |
| `/chat` | AI 对话 | 多轮流式对话（依赖设置页的模型配置；逐 token 渲染、思考过程折叠、可停止） |
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
- 视口宽度 < 900px：侧边栏自动收起为抽屉，点击顶栏菜单按钮展开，点击遮罩或切换路由后自动关闭；
- 统计卡片在窄屏下自动降为 2 列 / 1 列，布局不破。

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
