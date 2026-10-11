#!/usr/bin/env bun
// wdk <command>: one file per command in lib/cmd/, each exporting run(args) → exit code.
const COMMANDS = ['a11y', 'compat', 'smoke', 'shots', 'perf', 'load', 'serve-dir', 'install-browsers'];
const [cmd, ...args] = process.argv.slice(2);
if (!COMMANDS.includes(cmd)) {
	console.error(`usage: wdk <${COMMANDS.join('|')}> [options] — see the web-dev-kit README`);
	process.exit(2);
}
const { run } = await import(`../lib/cmd/${cmd}.js`);
try {
	process.exit((await run(args)) ?? 0);
} catch (e) {
	console.error(`wdk ${cmd}: ${e.message}`);
	process.exit(2);
}
