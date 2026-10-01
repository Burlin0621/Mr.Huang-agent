import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // 全局忽略：依赖、构建产物与素材预览临时目录（.avatar-preview 为本地验图脚本，非项目代码）
  { ignores: ['node_modules/', 'dist/', 'dist-ssr/', '.avatar-preview/'] },

  // 普通 JS（Node 环境的脚本与配置文件）
  {
    ...js.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // TypeScript（src 与根目录配置）
  ...tseslint.configs.recommended,

  // Electron 主进程 / preload（CommonJS，require 是必需的；需在 tseslint 配置之后覆盖）
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // scripts 下的 Node 冒烟/验证脚本（CommonJS，require 是必需的）
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

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
