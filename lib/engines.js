// Browsers. Two kinds:
//   playwright:  chrome (branded), chromium, firefox, webkit
//   exe:<firefox|chrome>:<path>  a binary Playwright cannot drive (FF115);
//                path may be $VAR; $WDK_FIREFOX_115, if unset, is fetched from the wdk flake
// Lessons from sonda-web's perf runs live here so every command inherits them.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { firefox115 } from './browsers.js';

export const PLAYWRIGHT = {
	chrome: [chromium, { channel: 'chrome' }],
	// The full build in new-headless mode: nixpkgs' Linux browsers ship it,
	// the separate headless shell is not guaranteed there.
	chromium: [chromium, { channel: 'chromium' }],
	// Linux CI runners forbid user namespaces: Firefox's sandbox then EPERMs and the
	// browser dies mid-call (seen: launch timeout, newPage "browser has been closed").
	firefox: [firefox, process.platform === 'linux' ? { env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1' }, firefoxUserPrefs: { 'security.sandbox.content.level': 0 } } : {}],
	// WebKit on Linux CI needs only an EGL driver (flake.nix, __EGL_VENDOR_LIBRARY_DIRS), not sandbox-off.
	webkit: [webkit, {}],
};

// Without these Playwright runs branded Chrome on SwiftShader (software GL):
// an animation costs ~2 cores that hardware-composited Chrome never spends.
// Checked 2026-10-04 by reading the WebGL renderer string in the measured page.
export const CHROME_ARGS = [
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--no-first-run',
	'--no-default-browser-check',
	'--use-angle=metal',
	'--disable-features=UnsafeSwiftShader',
];

export function parseEngine(spec) {
	if (spec.startsWith('exe:')) {
		const [, flavour, ...rest] = spec.split(':');
		let path = rest.join(':');
		if (!['firefox', 'chrome'].includes(flavour) || !path) throw new Error(`engine "${spec}": expected exe:firefox:<path> or exe:chrome:<path>`);
		if (path.startsWith('$')) {
			const value = process.env[path.slice(1)] ?? (path === '$WDK_FIREFOX_115' && process.platform === 'darwin' ? firefox115() : undefined);
			if (!value) throw new Error(`engine "${spec}": ${path} is not set`);
			path = value;
		}
		return { kind: 'exe', flavour, path, name: spec };
	}
	if (!PLAYWRIGHT[spec]) throw new Error(`unknown engine "${spec}" — ${Object.keys(PLAYWRIGHT).join(', ')}, or exe:<firefox|chrome>:<path>`);
	return { kind: 'playwright', name: spec };
}

// An x86 parent makes a universal browser launch translated: every timing and
// CPU number is garbage.
export function assertNative() {
	if (process.platform !== 'darwin') return;
	const translated = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).stdout.trim();
	if (translated === '1') throw new Error('running under Rosetta — browsers would launch translated. Use a native bun.');
}

export function launch(name) {
	const [type, opts] = PLAYWRIGHT[name];
	return type.launch(opts);
}

// A browser that crashes mid-call can leave that call pending forever (seen:
// Firefox dying during newPage). Under Bun, Playwright can also miss the exit
// entirely, so the disconnect event is backed by a deadline.
export function guard(browser, work, ms = 60_000) {
	let off;
	const crashed = new Promise((_, reject) => {
		const on = () => reject(new Error('browser crashed'));
		const timer = setTimeout(() => reject(new Error(`browser stalled (no answer in ${ms / 1000}s)`)), ms);
		browser.once('disconnected', on);
		off = () => (clearTimeout(timer), browser.off('disconnected', on));
	});
	return Promise.race([work, crashed]).finally(off);
}

// ---------- exe: engines, driven only by their command line ----------

export function exeCmd(engine, args) {
	return process.platform === 'darwin' && process.arch === 'arm64' ? ['arch', ['-arm64', engine.path, ...args]] : [engine.path, args];
}

export function exeLabel(engine) {
	const [cmd, args] = exeCmd(engine, ['--version']);
	return `${basename(engine.path)} ${spawnSync(cmd, args, { encoding: 'utf8' }).stdout.trim()}`;
}

// Throwaway profile per launch; its path is on the browser's command line,
// which is how every process of that launch is found and killed (Firefox
// relaunches itself, so its PID is no handle).
function profileArgs(engine) {
	const profile = mkdtempSync(join(tmpdir(), 'wdk-exe-'));
	const args =
		engine.flavour === 'firefox'
			? ['--headless', '--no-remote', '--profile', profile]
			// Linux CI runners forbid Chrome's user-namespace sandbox; Playwright disables it too.
			: ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
	return { profile, args };
}

// Async so the proxy keeps draining the dying browser's last requests.
export async function killProfile(profile) {
	spawnSync('pkill', ['-f', profile]);
	await Bun.sleep(500);
	spawnSync('pkill', ['-9', '-f', profile]);
	rmSync(profile, { recursive: true, force: true });
}

// Run a browser until it exits or `seconds` pass; a bad path rejects instead of crashing the process.
function runFor(cmd, argv, seconds) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, argv, { stdio: 'ignore' });
		const timer = setTimeout(resolve, seconds * 1000);
		child.on('exit', () => (clearTimeout(timer), resolve()));
		child.on('error', (e) => (clearTimeout(timer), reject(new Error(`${cmd}: ${e.message}`))));
	});
}

// Load a page and leave it running long enough for the beacon to report.
export async function exeVisit(engine, url, seconds = 3) {
	const { profile, args } = profileArgs(engine);
	const [cmd, argv] = exeCmd(engine, [...args, url]);
	try {
		await runFor(cmd, argv, seconds + 2); // ponytail: fixed launch + settle time
	} finally {
		await killProfile(profile);
	}
}

// The binary's own headless screenshot. Firefox: width-only --window-size
// captures the full page (W,H captures just the viewport; checked on FF115,
// 2026-10-05). Chrome's capture is the window, so it gets the page height
// measured elsewhere.
export async function exeScreenshot(engine, url, [width, height], out, fullHeight) {
	const { profile, args } = profileArgs(engine);
	const shot =
		engine.flavour === 'firefox'
			? [`--window-size=${width}`, '--screenshot', out]
			: [`--window-size=${width},${fullHeight ?? height}`, '--hide-scrollbars', `--screenshot=${out}`];
	const [cmd, argv] = exeCmd(engine, [...args, ...shot, url]);
	// Async on purpose: the proxy serving this page runs in our event loop.
	try {
		await runFor(cmd, argv, 60);
	} finally {
		await killProfile(profile);
	}
	return Bun.file(out).size > 0;
}
