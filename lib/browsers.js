// Browsers come from the wdk flake only when a command launches one: the dev
// shell exports WDK_FLAKE, never their store paths, so entering it fetches nothing.
import { spawnSync } from 'node:child_process';

// Realise flake packages, return their store paths (in order).
export function nixBuild(...attrs) {
	const flake = process.env.WDK_FLAKE;
	if (!flake) throw new Error(`WDK_FLAKE is not set — run inside the wdk dev shell (nix develop) to fetch ${attrs.join(', ')}`);
	const r = spawnSync('nix', ['build', '--no-link', '--print-out-paths', ...attrs.map((a) => `${flake}#${a}`)], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	if (r.status !== 0) throw new Error(`nix build ${attrs.join(' ')} failed`);
	return r.stdout.trim().split('\n');
}

// Linux: nixpkgs' Playwright browsers. Playwright reads PLAYWRIGHT_BROWSERS_PATH
// once, on import, so bin/wdk.js calls this before loading a browser command.
export function linuxBrowsers() {
	if (process.platform !== 'linux' || process.env.PLAYWRIGHT_BROWSERS_PATH || !process.env.WDK_FLAKE) return;
	const [browsers, mesa] = nixBuild('playwright-browsers', 'mesa');
	process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
	process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = 'true';
	// Nix's WebKit (WPE) finds no EGL driver off NixOS (no /run/opengl-driver) and
	// aborts every newPage: "Could not create EGL display". Point it at Mesa's.
	process.env.__EGL_VENDOR_LIBRARY_DIRS = `${mesa}/share/glvnd/egl_vendor.d`;
}

// macOS: the pinned Firefox 115 ESR, for `exe:firefox:$WDK_FIREFOX_115`.
export function firefox115() {
	return `${nixBuild('firefox-esr-115')[0]}/Applications/Firefox.app/Contents/MacOS/firefox`;
}
