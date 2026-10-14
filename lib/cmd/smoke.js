// wdk smoke: every crawled page in every engine; fails on runtime errors,
// console.error, and broken same-origin requests. A document 404 is fine —
// /does-not-exist is a start path on purpose — but a document 5xx is not.
import { parseArgs } from 'node:util';
import { enginesFor, loadConfig } from '../config.js';
import { exeVisit, guard, launch, parseEngine } from '../engines.js';
import { startProxy } from '../proxy.js';
import { crawl, eachPage, startSite, WORKERS } from '../site.js';
import { axe, report } from './a11y.js';

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { engines: { type: 'string' }, skip: { type: 'string' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const engines = enginesFor(config, o.engines).map(parseEngine);
	const browsers = warm(engines);
	const site = await startSite();
	const proxy = startProxy({ origin: site.origin, knobs: config.perf.knobs, block: config.proxy.block });
	try {
		const { lines, summary, code } = await smokeAll(engines, await crawl(site.origin, config.pages), proxy, { browsers });
		for (const l of [...lines, summary]) console.log(l);
		return code;
	} finally {
		proxy.stop();
		site.stop();
	}
}

// Axe runs in the first Blink engine's visits, or in a Chromium pass of its own when there is none.
const axeEngine = (engines, a11y) => a11y && (engines.find((e) => e.kind === 'playwright' && ['chromium', 'chrome'].includes(e.name))?.name ?? 'chromium');
const playwrightRuns = (engines, a11y) => [...new Set([...engines.filter((e) => e.kind === 'playwright').map((e) => e.name), axeEngine(engines, a11y)].filter(Boolean))];

// The Playwright browsers smokeAll will need, launching now: started before the site, their
// launch is free. A failed launch surfaces where smokeAll awaits it.
export function warm(engines, a11y = false) {
	const browsers = new Map(playwrightRuns(engines, a11y).map((name) => [name, fresh(name)]));
	for (const b of browsers.values()) b.catch(() => {});
	return browsers;
}

// Findings in engine, then page order, whatever order the parallel pages finished in.
// a11y: axe every page too, in the same visit; its { lines, summary, code } come back as `a11y`.
export async function smokeAll(engines, paths, proxy, { a11y = false, browsers = warm(engines, a11y) } = {}) {
	const found = [];
	const fail = (engine, path, reason) => found.push({ engine, path, reason });
	const audited = new Map();
	const axeOn = axeEngine(engines, a11y);
	const smoked = new Set(engines.map((e) => e.name));
	// Playwright engines side by side, splitting the page workers; then exe engines one at a
	// time, as they read the proxy's shared log.
	const names = playwrightRuns(engines, a11y);
	const workers = Math.max(2, Math.ceil(WORKERS / names.length));
	await Promise.all(names.map((name) => smokePlaywright(name, paths, proxy.url, smoked.has(name) ? fail : () => {}, { browser: browsers.get(name) ?? null, workers, audited: name === axeOn ? audited : null })));
	for (const engine of engines) if (engine.kind === 'exe') await smokeExe(engine, paths, proxy, fail);
	const rank = (f) => engines.findIndex((e) => e.name === f.engine) * 1e6 + paths.indexOf(f.path);
	const lines = found.sort((a, b) => rank(a) - rank(b)).map((f) => `✗ ${f.engine} ${f.path} — ${f.reason}`);
	return { lines, summary: `${paths.length} pages × ${engines.length} engine(s), ${found.length} error(s)`, code: found.length ? 1 : 0, a11y: a11y && report(audited, paths) };
}

// A failed launch is retried: on CI runners Firefox can die at newPage and again at the
// relaunch. A missing browser is not retried.
async function fresh(name) {
	for (let i = 1; ; i++) {
		try {
			return await launch(name);
		} catch (e) {
			if (i === 3 || e.missing) throw e;
			await Bun.sleep(2000);
		}
	}
}

async function smokePlaywright(name, paths, base, fail, { browser, workers, audited }) {
	const pathOf = (u) => new URL(u).pathname;
	const baseOrigin = new URL(base).origin;
	const own = (u) => new URL(u).origin === baseOrigin;
	const visit = async (browser, path) => {
		const page = await browser.newPage();
		let inflight = 0;
		let quiet = Date.now();
		page.on('request', () => inflight++);
		const settled = () => --inflight || (quiet = Date.now());
		page.on('requestfinished', settled);
		page.on('requestfailed', settled);
		page.on('pageerror', (e) => fail(name, path, `pageerror: ${e.message}`));
		// The browser's own "Failed to load resource" lines duplicate the response check below.
		page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && fail(name, path, `console.error: ${m.text()}`));
		// Aborted media range requests and requests cut off by page.close() are not a site issue.
		page.on('requestfailed', (r) => {
			if (!own(r.url())) return;
			const errorText = r.failure()?.errorText ?? '';
			if (errorText.includes('ERR_ABORTED') || errorText.includes('NS_BINDING_ABORTED') || errorText.includes('cancelled')) return;
			fail(name, path, `request failed: ${pathOf(r.url())} (${errorText})`);
		});
		page.on('response', (r) => {
			// Browsers fetch /favicon.ico unasked; a site without one is not broken.
			if (!own(r.url()) || pathOf(r.url()) === '/favicon.ico') return;
			const doc = r.request().isNavigationRequest() && r.request().frame() === page.mainFrame();
			if (r.status() >= (doc ? 500 : 400)) fail(name, path, `${r.status()} ${pathOf(r.url())}`);
		});
		try {
			await page.goto(base + path, { waitUntil: 'load' });
			// Until the network has been quiet for 100 ms, 500 ms at most: late requests and their
			// errors still land. ponytail: errors later than that, or on a page never quiet, are missed.
			quiet = Math.max(quiet, Date.now());
			for (const end = Date.now() + 500; Date.now() < end && (inflight > 0 || Date.now() - quiet < 100); ) await Bun.sleep(20);
			// An axe failure leaves the page unaudited, which the a11y report names; it is not a smoke error.
			if (audited) await axe(page).then((v) => audited.set(path, v), () => {});
		} catch (e) {
			if (e.message.includes('Timeout')) throw new Error(`browser stalled: ${e.message}`);
			fail(name, path, `navigation: ${e.message}`);
		} finally {
			await page.close();
		}
	};
	// A dead browser is replaced lazily. A page that crashes or stalls the browser gets one
	// retry on a fresh one before it counts as a failure.
	// Pages run side by side on one browser, shared as a promise so a crash relaunches it once.
	// A fully broken engine would otherwise cost 2 × 60s per page (~17 min for 41 pages):
	// after LOST pages in a row lose the browser, the rest are failed without trying.
	const LOST = 3;
	let lost = 0;
	try {
		await eachPage(paths, async (path) => {
			if (lost >= LOST) return fail(name, path, `not tried: ${LOST} pages in a row lost the browser`);
			for (let attempt = 1; ; attempt++) {
				const current = (browser ??= fresh(name));
				try {
					await guard(await current, visit(await current, path));
					lost = 0;
					return;
				} catch (e) {
					if (!/^(browser |newPage:)/.test(e.message)) throw e;
					// ponytail: a stalled browser is abandoned, not closed (close() can hang too); it dies with wdk
					if (browser === current) browser = null;
					if (attempt === 2) {
						lost++;
						return fail(name, path, e.message);
					}
				}
			}
		}, workers);
	} finally {
		// close() on an unnoticed dead browser never returns
		await Promise.race([browser?.then((b) => b.close(), () => {}), Bun.sleep(10_000)]);
	}
}

// Old binaries have no driver: the proxy is the instrument. The beacon reports
// script errors; the proxy's own log reports broken same-origin requests.
async function smokeExe(engine, paths, proxy, fail) {
	for (const path of paths) {
		proxy.errors.length = 0;
		proxy.responses.length = 0;
		proxy.loads.length = 0;
		await exeVisit(engine, proxy.url + path, () => proxy.loads.includes(path));
		if (!proxy.responses.some((r) => r.path === path)) fail(engine.name, path, 'page never loaded (browser did not start or reach the proxy)');
		for (const e of proxy.errors) if (e.type !== 'resource') fail(engine.name, path, `${e.type}: ${e.msg}`);
		for (const r of proxy.responses) if (r.path !== '/favicon.ico' && r.status >= (r.path === path ? 500 : 400)) fail(engine.name, path, `${r.status} ${r.path}`);
	}
}
