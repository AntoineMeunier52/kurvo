import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.nuxt/**'],
  },

  js.configs.recommended,

  ...tseslint.configs.strict,

  ...pluginVue.configs['flat/recommended'],

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',

      'vue/multi-word-component-names': 'off',

      'no-console': 'warn',
    },
  },

  {
    files: ['packages/core/**'],
    rules: {
      'vue/prefer-import-from-vue': 'off',
    },
  },

  prettier,
)
