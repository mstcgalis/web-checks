// The project's wdk.config.js over the defaults. Every key is optional.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = {
	pages: { start: ['/', '/does-not-exist'], skip: '', limit: 80 }, // ponytail: crawl cap; raise per project
	engines: { ci: ['chromium'], local: ['chromium'] },
	viewports: [[390, 844], [1440, 900]],
	compat: { css: [], targets: 'defaults', allow: [] },
	proxy: { block: [] },
	perf: { page: '/', knobs: {} },
	deploy: { host: '', dir: 'dist', build: 'just build' }, // host: user@host of the vps deploy key
};

export async function loadConfig(dir = process.cwd()) {
	const file = join(dir, 'wdk.config.js');
	let user = {};
	if (existsSync(file)) {
		try {
			user = (await import(file)).default ?? {};
		} catch (e) {
			const at = e.position ? `:${e.position.line}:${e.position.column}` : '';
			throw new Error(`wdk.config.js${at}: ${e.message}`);
		}
		// A typo'd key would silently check against the defaults.
		const unknown = Object.keys(user).filter((k) => !(k in DEFAULTS));
		if (unknown.length) throw new Error(`wdk.config.js: unknown key(s) ${unknown.join(', ')} — expected ${Object.keys(DEFAULTS).join(', ')}`);
	}
	const config = {};
	for (const [key, value] of Object.entries(DEFAULTS)) {
		const extra = Array.isArray(value) || !user[key] ? [] : Object.keys(user[key]).filter((k) => !(k in value));
		if (extra.length) throw new Error(`wdk.config.js: unknown key(s) ${extra.map((k) => `${key}.${k}`).join(', ')} — expected ${Object.keys(value).map((k) => `${key}.${k}`).join(', ')}`);
		config[key] = Array.isArray(value) ? (user[key] ?? value) : { ...value, ...user[key] };
	}
	return config;
}

// --engines wins; then CI's list on CI, the local list everywhere else.
export function enginesFor(config, override) {
	if (override) return override.split(',').filter(Boolean);
	return process.env.CI ? config.engines.ci : config.engines.local;
}
