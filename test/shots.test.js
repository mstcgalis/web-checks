import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { wdk, PROJECT, slow } from './run.js';

// Full Chrome for Testing never exits from --screenshot (checked on 153, macOS);
// Playwright's headless shell, a plain command-line Chromium, does.
const shellDir = chromium.executablePath().replace(/chromium-(\d+)\/.*/, 'chromium_headless_shell-$1');
const SHELL = join(shellDir, [...new Bun.Glob('*/chrome-headless-shell').scanSync(shellDir)][0]);

afterAll(() => rmSync(join(PROJECT, '.wdk'), { recursive: true, force: true }));

slow('shots writes a sheet: pages × (engine × viewport), exe engines included', async () => {
	const r = await wdk(['shots', '--engines', 'chromium,exe:chrome:$WDK_TEST_CHROME'], { WDK_TEST_CHROME: SHELL });
	expect(r.code).toBe(0);
	const sheet = r.out.match(/sheet: (.+)/)[1].trim();
	const html = readFileSync(sheet, 'utf8');
	expect(html.match(/<tr data-path=/g)).toHaveLength(4);
	expect(html.match(/<th data-col=/g)).toHaveLength(4);
	const pngs = readdirSync(dirname(sheet)).filter((f) => f.endsWith('.png'));
	expect(pngs).toHaveLength(16);
	expect(html).toMatch(/boom/); // the beacon / pageerror note under /broken
	expect(existsSync(join(PROJECT, '.wdk', 'shots'))).toBe(true);
}, 300_000);
