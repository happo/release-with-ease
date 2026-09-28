import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import configPrettier from 'eslint-config-prettier';
import pluginDepend from 'eslint-plugin-depend';
import pluginSimpleImportSort from 'eslint-plugin-simple-import-sort';
import pluginUnicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

type Config = ReturnType<typeof defineConfig>;

const config: Config = defineConfig(
  {
    ignores: ['.claude/**', 'coverage/**', 'dist/**'],
  },

  eslint.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.stylistic,
  pluginUnicorn.configs.unopinionated,

  {
    files: ['**/*.{js,ts}'],

    plugins: {
      depend: pluginDepend,
      'simple-import-sort': pluginSimpleImportSort,
    },

    extends: ['depend/flat/recommended'],

    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },

    rules: {
      // https://typescript-eslint.io/rules/array-type
      '@typescript-eslint/array-type': [
        'error',
        { default: 'generic', readonly: 'generic' },
      ],

      // https://typescript-eslint.io/rules/no-unused-vars
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // https://eslint.org/docs/latest/rules/curly
      curly: 'error',

      // https://eslint.org/docs/latest/rules/prefer-template
      'prefer-template': 'error',

      // https://github.com/lydell/eslint-plugin-simple-import-sort
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': 'error',
    },
  },

  {
    files: ['src/cli.ts'],
    rules: {
      // This is the CLI: process.exit(1) is how it reports an aborted or
      // failed release to the shell, and it ends the run at once rather than
      // leaving open handles (readline, child processes) to keep it alive.
      'unicorn/no-process-exit': 'off',
    },
  },

  // Last, so it turns off the rules above that would fight Prettier.
  configPrettier,
);

export default config;
