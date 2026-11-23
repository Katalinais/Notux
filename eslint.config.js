import js from '@eslint/js';
import globals from 'globals';

export default [
  // .claude/worktrees holds other branches' checkouts; backend/ has its own tooling.
  { ignores: ['node_modules/', '.claude/', 'backend/'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
  {
    files: ['sw.js'],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },
  {
    files: ['eslint.config.js', 'dev/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
