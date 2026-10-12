// wdk install-browsers [engine...]: Playwright's browsers at the wdk's pinned Playwright version,
// only those the engines need (the config's, plus Chromium for a11y) and not on disk already.
// Google Chrome stands in for Chromium, so with Chrome installed the default config downloads nothing.
// Linux gets them from the dev shell.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { enginesFor, loadConfig } from '../config.js';
import { installed, PLAYWRIGHT } from '../engines.js';

export async function run(names) {
	const asked = names.length ? names : [...enginesFor(await loadConfig()), 'chromium'];
	const unknown = asked.filter((n) => !n.startsWith('exe:') && !PLAYWRIGHT[n]);
	if (unknown.length) throw new Error(`unknown engine(s) ${unknown.join(', ')} — ${Object.keys(PLAYWRIGHT).join(', ')}`);
	if (asked.includes('chrome')) console.log('chrome: install Google Chrome itself; Playwright does not download it');
	// Named ones go to Playwright as asked (it skips what it has); the default list only what is missing.
	const want = [...new Set(asked)].filter((n) => ['chromium', 'firefox', 'webkit'].includes(n) && (names.length || !installed(n)));
	if (!want.length) return console.log('nothing to install'), 0;
	const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
	return Bun.spawnSync([process.execPath, cli, 'install', ...want], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode;
}
