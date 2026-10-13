#!/usr/bin/env bun
// wdk <command>: one file per command in lib/cmd/, each exporting run(args) → exit code.
const HELP = `wdk <command> [options]

checks: exit 0 pass, 1 findings, 2 broken setup
  check              compat + smoke + a11y on one server: run after every change
  compat             shipped CSS against compat.targets (caniuse)
  smoke              every page × engine: runtime errors, console.error, broken requests
  a11y               axe-core, WCAG 2.2 AA + best practice, every page

reports: exit 0
  load               cold load per page × viewport: LCP, image weight, heaviest files
  shots              contact sheet of pages × engine × viewport, in .wdk/shots/
  perf               CPU per perf knob (macOS)

setup
  new STACK DIR      a project from a template, on GitHub with its secrets; --domain D --vps HOST adds the deploy
  doctor             what is missing, and the command that fixes it
  update [--tag vX]  move the project to the latest wdk release (workflow pins and flake.lock)
  deploy [rollback|list]  stream the build to the host's restricted key; rollback, list
  install-browsers   the browsers your engines need (macOS; Linux: the dev shell)
  serve-dir DIR PORT static server for a justfile's serve-at

--engines a,b overrides the config's engines; --skip REGEX leaves pages out of the crawl.
Config: wdk.config.js. Details: https://github.com/mstcgalis/web-dev-kit#readme`;

const COMMANDS = ['new', 'check', 'a11y', 'compat', 'smoke', 'shots', 'perf', 'load', 'doctor', 'update', 'deploy', 'serve-dir', 'install-browsers'];
const [cmd, ...args] = process.argv.slice(2);
if (!cmd || ['help', '-h', '--help'].includes(cmd) || args.includes('--help') || args.includes('-h')) {
	console.log(HELP);
	process.exit(0);
}
if (!COMMANDS.includes(cmd)) {
	console.error(`wdk: unknown command "${cmd}"\n\n${HELP}`);
	process.exit(2);
}
if (['check', 'a11y', 'smoke', 'shots', 'perf', 'load', 'doctor'].includes(cmd)) {
	const { linuxBrowsers, macFirefoxHome } = await import('../lib/browsers.js');
	linuxBrowsers();
	macFirefoxHome();
}
const { run } = await import(`../lib/cmd/${cmd}.js`);
try {
	process.exit((await run(args)) ?? 0);
} catch (e) {
	console.error(`wdk ${cmd}: ${e.message}${e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? ' (wdk --help lists the options)' : ''}`);
	process.exit(2);
}
