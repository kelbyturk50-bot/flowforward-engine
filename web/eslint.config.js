import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  {
    files: ['**/*.{js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, __FF_VERCEL_ENV__: 'readonly' },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: '18.3' },
    },
    rules: {
      // rules-of-hooks and exhaustive-deps are the hooks contract this app
      // already follows. The plugin's v7 `recommended` preset also turns on
      // React Compiler rules that flag existing effect patterns; leave those
      // off so lint does not force behavior changes.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // Plain JSX, no PropTypes.
      'react/prop-types': 'off',
    },
  },
  {
    files: ['vite.config.js', 'vitest.config.js', 'playwright.config.js', 'eslint.config.js', 'src/test/**/*.{js,jsx}', 'e2e/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Node ignore script. The React plugin still visits it; give it the same
    // version the app files declare so lint does not warn.
    files: ['scripts/**/*.mjs'],
    settings: {
      react: { version: '18.3' },
    },
  },
];
