import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

export default defineConfig(
  globalIgnores(['dist/', '.verification-*/']),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    files: ['**/*.mjs', 'svelte.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.{svelte,ts}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: { parserOptions: { parser: ts.parser, svelteConfig } },
  },
);
