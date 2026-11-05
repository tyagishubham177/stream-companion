import { defineConfig } from '@playwright/test';
import path from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve('node_modules/.cache/ms-playwright');
export default defineConfig({ testDir: './tests/extension', timeout: 60000, expect: { timeout: 10000 }, workers: 1,
  reporter: 'list', outputDir: 'test-results', use: { trace: 'off', screenshot: 'only-on-failure' } });
