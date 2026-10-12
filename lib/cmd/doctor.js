// wdk doctor: everything a check needs, one line each, with the fix for what is missing. Exit 1 if anything is.
import { Glob } from 'bun';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { enginesFor, loadConfig } from '../config.js';
import { assertNative, installed, missing, PLAYWRIGHT } from '../engines.js';
import { startSite } from '../site.js';

export async function run() {
	let bad = 0;
	const ok = (msg) => console.log(`✓ ${msg}`);
	const no = (msg) => (bad++, console.log(`✗ ${msg}`));

	try {
		assertNative();
	} catch (e) {
		no(e.message);
	}

	let config;
	try {
		config = await loadConfig();
		ok(existsSync('wdk.config.js') ? 'wdk.config.js loads' : 'no wdk.config.js: defaults apply');
	} catch (e) {
		no(e.message);
		return 1;
	}

	// a11y always runs Chromium, whatever the engines say.
	for (const spec of new Set([...enginesFor(config), 'chromium'])) {
		if (spec.startsWith('exe:')) {
			const path = spec.split(':').slice(2).join(':');
			const value = path.startsWith('$') ? process.env[path.slice(1)] : path;
			if (value) existsSync(value) ? ok(`${spec}: ${value}`) : no(`${spec}: ${value} does not exist`);
			else if (path === '$WDK_FIREFOX_115' && process.platform === 'darwin' && process.env.WDK_FLAKE) ok(`${spec}: fetched from the wdk flake on first use`);
			else no(`${spec}: ${path} is not set`);
		} else if (!PLAYWRIGHT[spec]) no(`unknown engine "${spec}" in wdk.config.js — ${Object.keys(PLAYWRIGHT).join(', ')}, or exe:<firefox|chrome>:<path>`);
		else if (installed(spec)) ok(`${spec} installed${spec === 'chromium' && !existsSync(PLAYWRIGHT.chromium[0].executablePath()) ? ' (runs Google Chrome)' : ''}`);
		else no(missing(spec).message);
	}

	if (!config.compat.css.length) console.log('- compat.css not set: `wdk check` skips compat');
	else {
		let n = 0;
		for (const pattern of config.compat.css) for await (const _f of new Glob(pattern).scan('.')) n++;
		n ? ok(`compat.css matches ${n} file(s)`) : no(`compat.css ${JSON.stringify(config.compat.css)} matches no files — fix the globs in wdk.config.js`);
	}

	const just = spawnSync('just', ['--show', 'serve-at'], { encoding: 'utf8' });
	if (just.error) return no('just is not on PATH — enter the dev shell (nix develop, or direnv allow)'), 1;
	if (just.status !== 0) return no('the justfile has no `serve-at PORT` recipe — add one that runs a foreground server on PORT (static: `wdk serve-dir site {{PORT}}`)'), 1;
	try {
		const t = Date.now();
		const site = await startSite();
		site.stop();
		ok(`just serve-at answers (${Date.now() - t} ms)`);
	} catch (e) {
		no(e.message);
	}
	return bad ? 1 : 0;
}
