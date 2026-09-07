// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // The flat config is plain JS and is not part of the TypeScript
          // program; let the service give it a default project rather than
          // failing to resolve it.
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The benchmark and the report writer are console programs; writing to
      // stdout is the whole point of them.
      'no-console': 'off',
      // Scenario SQL is loaded and executed by construction. Template literals
      // built from files on disk are the design, not an oversight.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests reach into optional chains on query results constantly, and
      // asserting on them is the point.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
