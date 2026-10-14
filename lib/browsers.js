// Browsers come from the wdk flake only when a command launches one: the dev
// shell exports WDK_FLAKE, never their store paths, so entering it fetches nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Realise flake packages, return their store paths (in order). A `nix build` of paths already
// there still costs ~1s of evaluation per wdk run, so the answer is cached per flake ref (one
// per wdk version) and reused while every path still exists (a GC sends it back to nix).
export function nixBuild(...attrs) {
	const flake = process.env.WDK_FLAKE;
	if (!flake) throw new Error(`WDK_FLAKE is not set — run inside the wdk dev shell (nix develop) to fetch ${attrs.join(', ')}`);
	const refs = attrs.map((a) => `${flake}#${a}`);
	const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'wdk');
	const cache = join(dir, `nix-${Bun.hash(refs.join(' ')).toString(36)}`);
	try {
		const paths = readFileSync(cache, 'utf8').split('\n');
		if (paths.length === attrs.length && paths.every((p) => existsSync(p))) return paths;
	} catch {}
	const r = spawnSync('nix', ['build', '--no-link', '--print-out-paths', ...refs], {
		encoding: 'utf8',
		env: process.env,
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	if (r.status !== 0) throw new Error(`nix build ${attrs.join(' ')} failed`);
	const paths = r.stdout.trim().split('\n');
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(cache, paths.join('\n'));
	} catch {} // a read-only home only costs the next run its nix build
	return paths;
}

// Linux: nixpkgs' Playwright browsers. Playwright reads PLAYWRIGHT_BROWSERS_PATH
// once, on import, so bin/wdk.js calls this before loading a browser command.
export function linuxBrowsers() {
	if (process.platform !== 'linux') return;
	if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.WDK_FLAKE) {
		const [browsers, mesa] = nixBuild('playwright-browsers', 'mesa');
		process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
		process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = 'true';
		// Nix's WebKit (WPE) finds no EGL driver off NixOS (no /run/opengl-driver) and
		// aborts every newPage: "Could not create EGL display". Point it at Mesa's.
		process.env.__EGL_VENDOR_LIBRARY_DIRS = `${mesa}/share/glvnd/egl_vendor.d`;
	}
	// Playwright announces the skipped validation on stderr at every launch: noise in every run's output.
	if (process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS) {
		const write = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk, ...rest) => (String(chunk).startsWith('Skipping host requirements validation') ? true : write(chunk, ...rest));
	}
}

// macOS: the pinned Firefox 115 ESR, for `exe:firefox:$WDK_FIREFOX_115`.
export function firefox115() {
	return `${nixBuild('firefox-esr-115')[0]}/Applications/Firefox.app/Contents/MacOS/firefox`;
}

// macOS 27 privacy-protects ~/Library/Application Support/Firefox, which every
// Firefox (Playwright's and FF115) reads before -profile: the launch dies with
// "Could not find profile folder". A fresh fake home per wdk run sidesteps it
// (microsoft/playwright#42768); per run, because two Firefoxes sharing one collide.
export function macFirefoxHome() {
	if (process.platform !== 'darwin' || process.env.CFFIXED_USER_HOME) return;
	const home = mkdtempSync(join(tmpdir(), 'wdk-home-'));
	process.env.CFFIXED_USER_HOME = home;
	// Cleanup must never fail the run (Firefox can leave read-only files behind).
	// ponytail: a Firefox still dying may recreate empty dirs after this; they sit in TMPDIR.
	process.on('exit', () => spawnSync('sh', ['-c', 'chmod -R u+w "$0"; rm -rf "$0"', home]));
}
