export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', ['core', 'vue', 'editor', 'deps', 'ci', 'release']],
    'scope-empty': [1, 'never'],
  },
}
