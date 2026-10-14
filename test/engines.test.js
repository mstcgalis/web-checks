import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { guard, parseEngine } from '../lib/engines.js';

test('parseEngine: playwright names and exe specs', async () => {
	expect(parseEngine('webkit')).toEqual({ kind: 'playwright', name: 'webkit' });
	expect(parseEngine('exe:firefox:/opt/ff/firefox')).toEqual({ kind: 'exe', flavour: 'firefox', path: '/opt/ff/firefox', name: 'exe:firefox:/opt/ff/firefox' });
	expect(() => parseEngine('opera')).toThrow('unknown engine "opera"');
	expect(() => parseEngine('exe:safari:/x')).toThrow('exe:firefox:<path> or exe:chrome:<path>');
});

test('parseEngine expands $VAR paths and names a missing one', async () => {
	process.env.WDK_TEST_FF = '/opt/ff/firefox';
	expect(parseEngine('exe:firefox:$WDK_TEST_FF').path).toBe('/opt/ff/firefox');
	delete process.env.WDK_TEST_FF;
	expect(() => parseEngine('exe:firefox:$WDK_TEST_FF')).toThrow('$WDK_TEST_FF is not set');
});

test('guard: a call in flight when the browser dies rejects instead of hanging', async () => {
	const browser = await chromium.launch();
	const stuck = guard(browser, new Promise(() => {})).catch((e) => e.message);
	await browser.close();
	expect(await stuck).toBe('browser crashed');
}, 30_000);

test('guard: a call that never settles on a live browser stalls out', async () => {
	const browser = await chromium.launch();
	const stuck = guard(browser, new Promise(() => {}), 100).catch((e) => e.message);
	expect(await stuck).toContain('browser stalled');
	await browser.close();
}, 30_000);
