// wdk check: compat, smoke and a11y on one server and one crawl, side by side.
// The command to run after every change; each check's lines, then one summary line each.
import { parseArgs } from 'node:util';
import { enginesFor, loadConfig } from '../config.js';
import { parseEngine } from '../engines.js';
import { startProxy } from '../proxy.js';
import { crawl, startSite } from '../site.js';
import { lint } from './compat.js';
import { smokeAll, warm } from './smoke.js';

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { engines: { type: 'string' }, skip: { type: 'string' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const engines = enginesFor(config, o.engines).map(parseEngine);
	// No stylesheets configured is a skip here (a page-only project), unlike `wdk compat`.
	// Settled, never rejected: the site may fail to start before anyone awaits it.
	const compat = config.compat.css.length ? lint(config.compat).catch((e) => ({ error: e.message })) : Promise.resolve({ skipped: 'no compat.css in wdk.config.js' });
	const browsers = warm(engines, true);
	const site = await startSite();
	const proxy = startProxy({ origin: site.origin, knobs: config.perf.knobs, block: config.proxy.block });
	try {
		const paths = await crawl(site.origin, config.pages);
		const { a11y, ...smoke } = await smokeAll(engines, paths, proxy, { a11y: true, browsers });
		const results = { compat: await compat, smoke, a11y };
		let code = 0;
		for (const [name, r] of Object.entries(results)) {
			const label = name.padEnd(6);
			if (r.error) console.log(`✗ ${label} ${r.error}`);
			else if (r.skipped) console.log(`- ${label} skipped: ${r.skipped}`);
			else console.log([...r.lines, `${r.code ? '✗' : '✓'} ${label} ${r.summary}`].join('\n'));
			code = Math.max(code, r.error ? 2 : (r.code ?? 0));
		}
		return code;
	} finally {
		proxy.stop();
		site.stop();
	}
}
