// wdk load: every crawled page cold — no HTTP cache — once per viewport. Reports LCP and the image
// bytes fetched on load and after scrolling to the bottom, with the heaviest files. Chromium only
// (CDP throttling). Also when the largest image in view arrived: Chrome leaves a full-viewport image
// out of LCP, so a slow hero can hide behind a fast heading. --url measures a deployed site instead
// of the project's own server. --cdn checks every image's caching behind Cloudflare. --slow puts
// every viewport on Lighthouse's slow mobile: 1.6 Mbit/s, 150 ms, 4× CPU.
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { launch } from '../engines.js';
import { crawl, startSite } from '../site.js';

// A phone viewport gets a phone: 3× and a 4G link (150 ms, 16 Mbit/s). Anything wider is a 2×
// laptop on whatever the network is. ponytail: two fixed profiles; a config key when a site needs others.
const profile = ([width, height]) =>
	width < 768
		? { viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, net: { latency: 150, downloadThroughput: 2e6, uploadThroughput: 1e5 } }
		: { viewport: { width, height }, deviceScaleFactor: 2, isMobile: false, net: null };
const slow = { label: 'slow', net: { latency: 150, downloadThroughput: 2e5, uploadThroughput: 93_750 }, cpu: 4 };

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { skip: { type: 'string' }, url: { type: 'string' }, top: { type: 'string', default: '3' }, cdn: { type: 'boolean' }, slow: { type: 'boolean' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const site = o.url ? { origin: new URL(o.url).origin, stop() {} } : await startSite();
	let browser;
	try {
		const paths = await crawl(site.origin, config.pages);
		browser = await launch('chromium');
		for (const path of paths) {
			console.log(path);
			const seen = new Set();
			for (const size of config.viewports) {
				const p = o.slow ? { ...profile(size), ...slow } : profile(size);
				const r = await measure(browser, site.origin + path, p);
				console.log(
					`  ${size.join('×')}@${p.deviceScaleFactor}${p.net ? ` ${p.label ?? '4G'}` : ''}  LCP ${r.lcp}  ${r.hero}` +
						`images ${r.initial.size} files ${kb(sum(r.initial))} · after scroll ${r.all.size} files ${kb(sum(r.all))}`,
				);
				for (const [url, bytes] of [...r.all].sort((a, b) => b[1] - a[1]).slice(0, Number(o.top))) {
					const note = o.cdn ? `  ${(await cdn(url)).note}` : '';
					console.log(`      ${kb(bytes).padStart(7)}  ${url.replace(site.origin, '')}${note}`);
				}
				for (const url of r.all.keys()) seen.add(url);
			}
			if (o.cdn) {
				for (const url of seen) {
					for (const problem of (await cdn(url)).problems) console.log(`    ! ${url.replace(site.origin, '')} — ${problem}`);
				}
			}
		}
	} finally {
		await browser?.close();
		site.stop();
	}
	return 0;
}

// Each image once per run: fetched twice as a visitor would — the first may fill a cold edge, the
// second should be a HIT — and once with a cache-busting query the CDN must pass to the origin,
// which is what a visitor who misses the edge waits for.
const checked = new Map();
function cdn(url) {
	if (!checked.has(url)) checked.set(url, checkCdn(url));
	return checked.get(url);
}

async function timed(url) {
	const t = performance.now();
	const res = await fetch(url, { headers: { accept: 'image/avif,image/webp,*/*' } });
	await res.arrayBuffer();
	return { res, ms: Math.round(performance.now() - t) };
}

async function checkCdn(url) {
	await timed(url);
	const { res, ms } = await timed(url);
	const bust = new URL(url);
	bust.searchParams.set('wdk-bust', crypto.randomUUID());
	const origin = await timed(bust.href);
	const status = res.headers.get('cf-cache-status');
	const cacheControl = res.headers.get('cache-control') ?? '';
	const problems = [];
	if (!/(s-)?max-age=[1-9]/.test(cacheControl) || /no-store|no-cache|private/.test(cacheControl)) {
		problems.push(`not cacheable (cache-control: ${cacheControl || 'none'})`);
	}
	if (status && status !== 'HIT') problems.push(`second request was ${status}, not HIT`);
	return { note: status ? `${status} ${ms} ms · origin ${origin.ms} ms` : `no cf-cache-status · ${ms} ms`, problems };
}

async function measure(browser, url, p) {
	const ctx = await browser.newContext({ viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, isMobile: p.isMobile });
	try {
		const page = await ctx.newPage();
		const cdp = await ctx.newCDPSession(page);
		await cdp.send('Network.enable');
		await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
		if (p.net) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...p.net });
		if (p.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
		// Bytes on the wire (encodedDataLength), per URL; data: URIs never reach the network.
		const pending = new Map();
		const all = new Map();
		cdp.on('Network.responseReceived', (e) => e.type === 'Image' && !e.response.url.startsWith('data:') && pending.set(e.requestId, e.response.url));
		cdp.on('Network.loadingFinished', (e) => pending.has(e.requestId) && all.set(pending.get(e.requestId), e.encodedDataLength));
		await page.addInitScript(() => {
			new PerformanceObserver((list) => {
				const e = list.getEntries().at(-1);
				window.__wdkLcp = { t: e.startTime, what: e.url ? e.url.split('/').pop() : `<${e.element?.localName ?? '?'}> text` };
			}).observe({ type: 'largest-contentful-paint', buffered: true });
		});
		await page.goto(url, { waitUntil: 'load' });
		// The first paint can come well after load (a script that renders late, a renderer slow to
		// produce frames): wait for an LCP entry, then a moment for a larger candidate to replace it.
		await page.waitForFunction(() => window.__wdkLcp, null, { timeout: 10_000 }).catch(() => {});
		await page.waitForTimeout(500);
		const l = await page.evaluate(() => window.__wdkLcp);
		// The visible image covering the most of the viewport, once it is in: its responseEnd, on the
		// same clock as LCP.
		const hero = await page
			.waitForFunction(
				() => {
					const area = (r) => Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
					const img = [...document.images]
						.filter((i) => i.currentSrc && !i.currentSrc.startsWith('data:') && i.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
						.map((i) => [area(i.getBoundingClientRect()), i])
						.filter(([a]) => a > 0)
						.sort((a, b) => b[0] - a[0])[0]?.[1];
					if (!img) return { none: true };
					if (!img.complete) return false;
					return { t: performance.getEntriesByName(img.currentSrc)[0]?.responseEnd, what: img.currentSrc.split('/').pop() };
				},
				null,
				{ timeout: 60_000, polling: 100 },
			)
			.then((h) => h.jsonValue())
			.catch(() => null);
		const initial = new Map(all);
		// Scroll to the bottom, so lazy images below the fold load too. A step that does not move
		// (a scroll lock, no new frame yet) is retried for about 5 s; an endless page stops at 200 screens.
		for (let steps = 0, stalled = 0, last = -1; steps < 200 && stalled < 33; steps++) {
			await page.mouse.wheel(0, p.viewport.height);
			await page.waitForTimeout(150);
			const { y, bottom } = await page.evaluate(() => ({ y: scrollY, bottom: scrollY + innerHeight >= document.documentElement.scrollHeight - 1 }));
			if (bottom) break;
			stalled = y === last ? stalled + 1 : 0;
			last = y;
		}
		await page.waitForLoadState('networkidle').catch(() => {});
		return {
			lcp: l ? `${Math.round(l.t)} ms (${l.what})` : 'none (no contentful paint within 10 s)',
			hero: !hero ? 'hero not in within 60 s  ' : hero.none ? '' : `hero ${hero.t ? `${Math.round(hero.t)} ms` : 'cached'} (${hero.what})  `,
			initial,
			all,
		};
	} finally {
		await ctx.close();
	}
}
