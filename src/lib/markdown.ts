/**
 * Markdown 渲染（模块级单例，流式增量复用同一实例）：
 * - markdown-it：气泡内 Markdown 解析（html:false 不透传原始 HTML，linkify 自动链接，
 *   breaks 单换行转 <br> 适配聊天排版；链接统一 target=_blank + rel=noopener）；
 * - DOMPurify：渲染结果一律消毒后再 v-html（会话内容含模型输出的任意文本，防 XSS；
 *   USE_PROFILES html 限定安全标签集合，script/iframe/事件属性被默认剥离）。
 * 代码块不做语法高亮（等宽 + tokens 底色即可，见 RichText 组件样式）。
 */
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

/** renderer 规则函数签名（从实例 rules 表提取，避免依赖包内部类型路径） */
type RenderRule = NonNullable<(typeof md.renderer.rules)['link_open']>

// 链接统一新窗口打开并加 noopener（DOMPurify hook 再兜底强制）
const renderLinkOpen: RenderRule = (tokens, idx, _options, _env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return self.renderToken(tokens, idx, _options)
}
md.renderer.rules.link_open = renderLinkOpen

// DOMPurify hook：消毒后仍强制外链安全属性（覆盖属性被剥离后丢失的情况）
let hookInstalled = false
function ensurePurifyHook(): void {
  if (hookInstalled) return
  hookInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

/** 把 Markdown 文本渲染为已消毒的 HTML 字符串（供 v-html 使用） */
export function renderMarkdown(source: string): string {
  ensurePurifyHook()
  const html = md.render(source ?? '')
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
