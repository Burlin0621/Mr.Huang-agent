/**
 * 内置技能（提示词模板）：点击后把模板文案追加进输入框，
 * 用户在模板后补充素材即可发送。纯数据模块（零依赖）。
 */

export interface SkillDefinition {
  id: string
  /** 展示名称 */
  name: string
  /** 一句话描述（浮层列表中展示） */
  description: string
  /** 追加进输入框的模板文案（通常以换行结尾，便于用户续贴素材） */
  template: string
}

export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: 'summarize',
    name: '总结要点',
    description: '把长内容提炼成分条要点',
    template: '请把以下内容总结为分条要点，保留核心信息、数据与结论，并在最后用一句话概括：\n',
  },
  {
    id: 'translate-en',
    name: '翻译成英文',
    description: '将内容忠实翻译为英文',
    template: '请把以下内容翻译成英文，忠实原意、术语准确，保留原有格式与代码块：\n',
  },
  {
    id: 'code-review',
    name: '代码审查',
    description: '找 bug、安全隐患与改进建议',
    template: '请审查以下代码：指出潜在 bug、安全隐患与性能问题，并按高/中/低优先级给出具体改进建议：\n',
  },
  {
    id: 'expand-polish',
    name: '扩写润色',
    description: '把草稿扩写得更完整流畅',
    template: '请对以下草稿进行扩写与润色：语言更流畅、表达更有力、补全缺失的逻辑；保持原意与事实不变，不虚构数据：\n',
  },
  {
    id: 'title-ideas',
    name: '起标题',
    description: '生成多个候选标题',
    template: '请为以下内容拟 6 个候选标题，覆盖直叙、悬念、观点等不同风格，各注明适用场景，并推荐其中 1 个：\n',
  },
]
