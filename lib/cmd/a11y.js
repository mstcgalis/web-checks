// wdk a11y: axe-core (WCAG 2.2 AA + best practice) over every crawled page. Any violation fails.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { launch } from '../engines.js';
import { crawl, eachPage, startSite } from '../site.js';

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { skip: { type: 'string' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const site = await startSite();
	try {
		const { lines, summary, code } = await audit(site.origin, await crawl(site.origin, config.pages));
		for (const l of [...lines, summary]) console.log(l);
		return code;
	} finally {
		site.stop();
	}
}

// One line per rule, then the pages it hit: the same missing alt on 40 pages is one finding to fix.
export async function audit(origin, paths) {
	const axePath = createRequire(import.meta.url).resolve('axe-core');
	const rules = new Map(); // id → { v, hits: [[path, nodes]] }
	const browser = await launch('chromium');
	try {
		await eachPage(paths, async (path) => {
			const page = await browser.newPage();
			try {
				await page.goto(origin + path);
				await page.addScriptTag({ path: axePath });
				const { violations } = await page.evaluate(() => axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
				for (const v of violations) {
					if (!rules.has(v.id)) rules.set(v.id, { v, hits: [] });
					rules.get(v.id).hits.push([path, v.nodes]);
				}
			} finally {
				await page.close();
			}
		});
	} finally {
		await browser.close();
	}
	const lines = [];
	let failed = 0;
	for (const { v, hits } of [...rules.values()].sort((a, b) => a.v.id.localeCompare(b.v.id))) {
		failed += hits.length;
		lines.push(`✗ ${v.id} (${v.impact}): ${v.help} — ${hits.length} page(s)`);
		for (const [path, nodes] of hits.sort(([a], [b]) => paths.indexOf(a) - paths.indexOf(b))) {
			lines.push(`    ${path}  ${nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}${nodes.length > 3 ? ` +${nodes.length - 3}` : ''}`);
		}
	}
	return { lines, summary: `${paths.length} pages, ${failed} violation(s)`, code: failed ? 1 : 0 };
}
