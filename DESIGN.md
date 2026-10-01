# DESIGN.md · 视觉世界定案（v4）

「不懒小熊」品牌视觉世界。本文件是后续所有 UI 阶段的唯一视觉依据，
替代旧的靛蓝体系记录。具体数值以 `src/styles/tokens.css` 为准，二者同步维护。

## 1. 色板

### 中性阶（暖色相 hue≈25，饱和度 ≤6%，明度台阶均衡）

| 令牌 | 浅色 | 深色 |
| --- | --- | --- |
| --sidebar-bg | #1b1713 | #0f0c0a |
| --color-bg | #f5f3f0 | #161311 |
| --color-surface-muted | #eceae6 | #28231f |
| --color-surface | #fffefc | #1e1a17 |
| --color-border | #e4e1dc | #322c27 |
| --color-border-strong | #d2cec7 | #47403a |
| --color-text | #1c1917 | #f0ece7 |
| --color-text-secondary | #57534e | #b6afa6 |
| --color-text-muted | #78716c | #857d73 |
| --sidebar-text / muted | #e8e2da / #a89f93 | #d9d2c8 / #8f877b |
| --sidebar-hover-bg | rgba(255,255,255,0.08) | rgba(255,255,255,0.06) |
| --sidebar-active-bg | rgba(255,106,0,0.30) | rgba(255,138,51,0.26) |
| --topbar-bg | rgba(255,254,252,0.85) | rgba(22,19,17,0.85) |
| --overlay-bg | rgba(28,25,23,0.52) | rgba(8,6,5,0.6) |

### 品牌橙（唯一行动色）

| 阶 | 浅色 | 深色 |
| --- | --- | --- |
| 50 | #fff1e8 | rgba(255,138,51,0.14) |
| 100 | #ffe0cc | rgba(255,138,51,0.22) |
| 200 | #ffc199 | rgba(255,138,51,0.34) |
| 500 | #FF6A00 | #ff8a33 |
| 600 | #e85f00 | #ff9d57 |
| 700 | #c95400 | #e87418 |
| on-brand | #ffffff | #241000 |

别名：--color-brand=500、strong=600、deep=700、soft=50。accent 黄 #FFB400（暗色 #ffb84d）、on-accent 白。

### 信息蓝（信息色，与行动橙不混用）

浅色 500 #006BFF / 600 #0057d1 / soft #e6efff；深色 500 #5c9bff / 600 #82b3ff / soft rgba(92,155,255,0.16)。

### 语义色（实色 + soft 成对，暖协调）

| 语义 | 浅色实色 | 浅色 soft | 深色实色 | 深色 soft |
| --- | --- | --- | --- | --- |
| success | #16A34A | #ddf3e4 | #46cf90 | rgba(70,207,144,0.14) |
| warning | #B45309 | #f9efdb | #eab04d | rgba(234,176,77,0.14) |
| danger | #E5484D | #fdeaea | #ef8c8c | rgba(239,140,140,0.14) |
| danger-strong | #c73a3f | — | #c74747 | — |

## 2. 明度阶梯原理

同一暖色相 hue≈25 下按明度严格递进排列：侧边栏（最暗近黑）→ 页面背景 →
内嵌底 → 卡片表面 → 边框 → 文字。相邻层级明度台阶保持均衡，任意一层
换色不得破坏整体递进关系。侧边栏不是纯黑，而是与暖灰/米同色温的暖近黑，
消除「黑/灰/米」三段色相断层。深色主题按同一原理独立推导，非浅色反色。

## 3. 字体层级

- 字族：--font-sans（Inter / HarmonyOS Sans SC / PingFang SC / Microsoft YaHei）；
  代码 --font-mono。
- 字号：xs 12 / sm 13 / md 14 / lg 16 / xl 20 / 2xl 26 / 3xl 30。
- 字重：正文 400–500，强调 600，标题 700，display **800**
  （--font-weight-display，页面主标题与空状态标语，承接品牌 Heavy 语言）。

## 4. 图形语言（几何点缀）

品牌几何语言：圆点、圆环、叉号、波点。使用规则：

1. 低干扰：仅用于空状态、区块标题旁、分隔装饰，单屏 ≤3 处，不与按钮/
   输入/链接等功能元素竞争注意力。
2. 一律 `aria-hidden="true"`，纯装饰不进无障碍树。
3. 颜色只从 brand-50/100/200、accent 黄、border 淡色取，禁用高饱和实色大面积铺陈。
4. 圆角贴纸感：卡片 --radius-lg(16px)、chip/按钮 --radius-full，元素有轻微
   「贴纸」悬浮感（阴影 --shadow-sm/md），不做锐利直角。

## 5. 双主题同等原则

浅色与深色是两个独立推导的同等主题，不是反色关系：各自拥有完整的暖灰阶、
提亮版品牌橙/蓝/语义色与专属阴影。任何新组件必须两主题同时验收：
对比度（正文 ≥4.5:1，侧栏文字 ≥7:1 / muted ≥4.5:1）、hover/active 层级、阴影可见性。

## 6. 组件形态规范

- 按钮：主按钮 brand-500 实底 + on-brand 白字（hover 600 / active 700），
  圆角 --radius-full 或 --radius-md；次级按钮 surface 底 + border 描边；
  危险按钮 danger 实底（hover danger-strong）。字重 600。
- 卡片：--color-surface 底、--radius-lg、--color-border 描边 + --shadow-sm/md；
  hover 浮起只加深阴影不加边框色相。
- chip / 标签：--radius-full，浅底取对应色阶 soft，文字取实色；信息类用 info。
- 模态 / 抽屉：--overlay-bg 遮罩、--color-surface 面板、--radius-lg、--shadow-lg，
  进入动效统一 --transition-theme 缓动。

## 7. 动效

--ease-out-soft 统一缓动；hover/active/focus 用 --transition-fast(150ms)，
主题切换用 --transition-theme(240ms)。颜色过渡一律走令牌，不写死时长。
