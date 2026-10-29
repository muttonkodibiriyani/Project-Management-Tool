import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  // node:test runs and awaits every test() it is given.
  { files: ['src/**/*.test.ts'], rules: { '@typescript-eslint/no-floating-promises': 'off' } },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
);
