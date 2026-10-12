// wdk compat: shipped CSS against the project's browser targets (caniuse data
// through doiuse). Static and fast; it says nothing about JS — `wdk smoke` in
// old engines covers that. Progressive enhancement inside @supports is still
// reported: list those feature ids in compat.allow.
import { Glob } from 'bun';
import { parseArgs } from 'node:util';
import doiuse from 'doiuse';
import postcss from 'postcss';
import { loadConfig } from '../config.js';

export async function run(args) {
	parseArgs({ args, options: {} });
	const r = await lint((await loadConfig()).compat);
	if (r.error) {
		console.error(`wdk compat: ${r.error}`);
		return 2;
	}
	for (const l of [...r.lines, r.summary]) console.log(l);
	return r.code;
}

// { lines, summary, code }, or { error } for a config that cannot be checked.
export async function lint(compat) {
	if (!compat.css.length) return { error: 'set compat.css (globs of shipped stylesheets) in wdk.config.js' };
	const files = [];
	for (const pattern of compat.css) for await (const file of new Glob(pattern).scan('.')) files.push(file);
	if (!files.length) return { error: `compat.css ${JSON.stringify(compat.css)} matched no files` };
	const lines = [];
	for (const file of files.sort()) {
		const report = (usage) => {
			// doiuse prefixes "<abs path>:<line>:<col>: "; keep only the message.
			lines.push(`✗ ${file}:${usage.usage.source.start.line} — ${usage.message.split(': ').slice(1).join(': ')}`);
		};
		await postcss([doiuse({ browsers: compat.targets, ignore: compat.allow, onFeatureUsage: report })]).process(await Bun.file(file).text(), { from: file });
	}
	return { lines, summary: `${files.length} file(s), ${lines.length} unsupported feature use(s) for "${compat.targets}"`, code: lines.length ? 1 : 0 };
}
