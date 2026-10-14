// wdk a11y: axe-core (WCAG 2.2 AA + best practice) over every crawled page. Any violation fails.
// Axe runs inside smoke's Chromium visit (lib/cmd/smoke.js): `wdk check` loads each page once.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { startProxy } from '../proxy.js';
import { crawl, startSite } from '../site.js';
import { smokeAll, warm } from './smoke.js';

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { skip: { type: 'string' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const browsers = warm([], true);
	const site = await startSite();
	const proxy = startProxy({ origin: site.origin, knobs: config.perf.knobs, block: config.proxy.block });
	try {
		const { a11y } = await smokeAll([], await crawl(site.origin, config.pages), proxy, { a11y: true, browsers });
		for (const l of [...a11y.lines, a11y.summary]) console.log(l);
		return a11y.code;
	} finally {
		proxy.stop();
		site.stop();
	}
}

// Evaluated, not a script tag: a page's CSP cannot block it, and a page's AMD `define` cannot capture it.
let source;
export async function axe(page) {
	source ??= await Bun.file(createRequire(import.meta.url).resolve('axe-core')).text();
	const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
	const { violations } = await page.evaluate(`(function(){var define,module,exports;${source}\nreturn axe.run({runOnly:${JSON.stringify(tags)}})})()`);
	return violations;
}

// One line per rule, then the pages it hit: the same missing alt on 40 pages is one finding to fix.
// `found`: path → violations, for every page axe ran on.
export function report(found, paths) {
	const rules = new Map(); // id → { v, hits: [[path, nodes]] }
	for (const path of paths) {
		for (const v of found.get(path) ?? []) {
			if (!rules.has(v.id)) rules.set(v.id, { v, hits: [] });
			rules.get(v.id).hits.push([path, v.nodes]);
		}
	}
	const lines = [];
	let failed = 0;
	for (const { v, hits } of [...rules.values()].sort((a, b) => a.v.id.localeCompare(b.v.id))) {
		failed += hits.length;
		lines.push(`✗ ${v.id} (${v.impact}): ${v.help} — ${hits.length} page(s)`);
		for (const [path, nodes] of hits) {
			lines.push(`    ${path}  ${nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}${nodes.length > 3 ? ` +${nodes.length - 3}` : ''}`);
		}
	}
	const unaudited = paths.filter((p) => !found.has(p));
	if (unaudited.length) lines.push(`✗ not audited, the page did not load (wdk smoke says why): ${unaudited.join(', ')}`);
	const summary = `${paths.length} pages, ${failed} violation(s)${unaudited.length ? `, ${unaudited.length} not audited` : ''}`;
	return { lines, summary, code: failed || unaudited.length ? 1 : 0 };
}
