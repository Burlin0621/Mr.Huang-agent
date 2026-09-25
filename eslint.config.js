import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // 全局忽略：依赖与构建产物
  { ignores: ['node_modules/', 'dist/', 'dist-ssr/'] },

  // 普通 JS（Node 环境的脚本与配置文件）
  {
    ...js.configs.recommended,
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // TypeScript（src 与根目录配置）
  ...tseslint.configs.recommended,

  // Vue 3（flat/recommended 含模板规则）
  ...pluginVue.configs['flat/recommended'],

  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // .vue 内 <script lang="ts"> 交给 typescript-eslint 解析
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  // 规则微调：保持宽松，避免过度约束
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // 格式化交给 Prettier，关闭与之冲突的规则（必须放最后）
  prettierConfig,
)
