import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { crawl, startSite } from '../lib/site.js';
import { PROJECT, slow } from './run.js';

const pages = {
	'/': '<a href="a">a</a> <a href="/b#x">b</a> <a href="/b?y=1">b again</a> <a href="/style.css">css</a> <a href="https://example.com/">away</a>',
	'/a': '<a href="/c">c</a>',
	'/b': '<a href="/d">d</a>',
	'/slow': '<a href="/hang">hang</a> <a href="/a">a</a>',
};
const server = Bun.serve({
	port: 0,
	fetch: (req) => {
		if (new URL(req.url).pathname === '/hang') return new Promise(() => {});
		const body = pages[new URL(req.url).pathname];
		return new Response(body ?? 'nope', { status: body ? 200 : 404, headers: { 'content-type': 'text/html' } });
	},
});
afterAll(() => server.stop(true));
const origin = `http://localhost:${server.port}`;

test('crawl resolves relative links, drops fragments, queries, files and other origins', async () => {
	expect(await crawl(origin, { start: ['/'], skip: '', limit: 80 })).toEqual(['/', '/a', '/b', '/c', '/d']);
});

test('crawl honours skip and limit', async () => {
	expect(await crawl(origin, { start: ['/'], skip: '^/a', limit: 80 })).toEqual(['/', '/b', '/d']);
	expect(await crawl(origin, { start: ['/'], skip: '', limit: 2 })).toEqual(['/', '/a']);
});

test('crawl keeps a page that never answers and goes on', async () => {
	expect(await crawl(origin, { start: ['/slow'], skip: '', limit: 80 }, 200)).toEqual(['/slow', '/hang', '/a', '/c']);
});

test('loadConfig fills defaults under the project file', async () => {
	const c = await loadConfig(PROJECT);
	expect(c.pages).toEqual({ start: ['/', '/does-not-exist'], skip: '', limit: 80 });
	expect(c.viewports).toEqual([[390, 844], [1280, 800]]);
	expect((await loadConfig(tmpdir())).engines.local).toEqual(['chromium']);
});

test('startSite fails fast and names the recipe when serve-at dies', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-noserve-'));
	writeFileSync(join(dir, 'justfile'), 'serve-at PORT:\n    exit 1\n');
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		const t = Date.now();
		await expect(startSite()).rejects.toThrow(/just serve-at \d+/);
		expect(Date.now() - t).toBeLessThan(11_000);
	} finally {
		process.chdir(cwd);
	}
}, 15_000);

test('startSite does not take a port thief for the site', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-thief-'));
	// The "thief" answers on PORT, then serve-at itself exits as if its bind failed.
	writeFileSync(join(dir, 'justfile'), "serve-at PORT:\n    bun -e 'Bun.serve({ port: {{PORT}}, fetch: () => new Response(\"thief\") }); setTimeout(() => process.exit(), 5000)' & sleep 0.2; exit 1\n");
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		await expect(startSite()).rejects.toThrow(/exited/);
	} finally {
		process.chdir(cwd);
	}
}, 30_000);

slow('startSite gives up on a server that accepts but never answers', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-mute-'));
	writeFileSync(join(dir, 'justfile'), "serve-at PORT:\n    bun -e 'Bun.serve({ port: {{PORT}}, fetch: () => new Promise(() => {}) })'\n");
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		await expect(startSite()).rejects.toThrow(/never answered/);
	} finally {
		process.chdir(cwd);
	}
}, 20_000);
