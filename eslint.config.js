// Lint rules for the whole project: ESLint's recommended set, with the right globals per folder.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'demo-dist/'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
  { files: ['src/server/**', 'scripts/**', 'test/**', 'demo/build.mjs', 'eslint.config.js'], languageOptions: { globals: globals.node } },
  // src/core runs in Node and in the browser.
  { files: ['src/core/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['web/**', 'demo/api.js'], languageOptions: { globals: globals.browser } },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
