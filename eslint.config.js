// ESLint configuration: catches real mistakes (undefined or unused names, unreachable code, ...)
// without enforcing a formatting style.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-control-regex': 'off', // PHP byte strings are matched with \x00-\x1f ranges on purpose
      'no-cond-assign': ['error', 'except-parens'],
      'no-fallthrough': 'error',
      'no-shadow-restricted-names': 'error',
      'prefer-const': 'off',
    },
  },
];
