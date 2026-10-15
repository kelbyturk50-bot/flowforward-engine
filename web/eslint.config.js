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
      globals: { ...globals.browser },
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
    files: ['vite.config.js', 'vitest.config.js', 'eslint.config.js', 'src/test/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
