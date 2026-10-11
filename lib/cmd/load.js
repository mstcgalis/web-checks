// wdk load: every crawled page cold — no HTTP cache — once per viewport. Reports LCP and the image
// bytes fetched on load and after scrolling to the bottom, with the heaviest files. Chromium only
// (CDP throttling). --url measures a deployed site instead of the project's own server.
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { loadConfig } from '../config.js';
import { crawl, startSite } from '../site.js';

// A phone viewport gets a phone: 3× and a 4G link (150 ms, 16 Mbit/s). Anything wider is a 2×
// laptop on whatever the network is. ponytail: two fixed profiles; a config key when a site needs others.
const profile = ([width, height]) =>
	width < 768
		? { viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, net: { latency: 150, downloadThroughput: 2e6, uploadThroughput: 1e5 } }
		: { viewport: { width, height }, deviceScaleFactor: 2, isMobile: false, net: null };

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { skip: { type: 'string' }, url: { type: 'string' }, top: { type: 'string', default: '3' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const site = o.url ? { origin: new URL(o.url).origin, stop() {} } : await startSite();
	let browser;
	try {
		const paths = await crawl(site.origin, config.pages);
		browser = await chromium.launch({ channel: 'chromium' });
		for (const path of paths) {
			console.log(path);
			for (const size of config.viewports) {
				const p = profile(size);
				const r = await measure(browser, site.origin + path, p);
				console.log(
					`  ${size.join('×')}@${p.deviceScaleFactor}${p.net ? ' 4G' : ''}  LCP ${r.lcp}  ` +
						`images ${r.initial.size} files ${kb(sum(r.initial))} · after scroll ${r.all.size} files ${kb(sum(r.all))}`,
				);
				for (const [url, bytes] of [...r.all].sort((a, b) => b[1] - a[1]).slice(0, Number(o.top))) {
					console.log(`      ${kb(bytes).padStart(7)}  ${url.replace(site.origin, '')}`);
				}
			}
		}
	} finally {
		await browser?.close();
		site.stop();
	}
	return 0;
}

async function measure(browser, url, p) {
	const ctx = await browser.newContext({ viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, isMobile: p.isMobile });
	try {
		const page = await ctx.newPage();
		const cdp = await ctx.newCDPSession(page);
		await cdp.send('Network.enable');
		await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
		if (p.net) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...p.net });
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
		await page.waitForTimeout(500);
		const l = await page.evaluate(() => window.__wdkLcp);
		const initial = new Map(all);
		// Scroll until the page stops growing, so lazy images below the fold load too.
		for (let last = -1, y = 0; y !== last; ) {
			last = y;
			await page.mouse.wheel(0, p.viewport.height);
			await page.waitForTimeout(150);
			y = await page.evaluate(() => scrollY);
		}
		await page.waitForLoadState('networkidle').catch(() => {});
		return { lcp: l ? `${Math.round(l.t)} ms (${l.what})` : 'none', initial, all };
	} finally {
		await ctx.close();
	}
}
