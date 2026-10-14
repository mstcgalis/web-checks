import { expect, test } from 'bun:test';
import { summarise, variants } from '../lib/cmd/perf.js';
import { wdk } from './run.js';

const knobs = { spin: { css: 'x' }, ticker: { script: 'ticker' } };

test('variants: static floor, shipped, then each knob; --off lists override', async () => {
	expect(variants(knobs).map((v) => v.name)).toEqual(['static', 'shipped', '-spin', '-ticker']);
	expect(variants(knobs, ['spin,ticker'])).toEqual([{ name: '-spin,-ticker', off: ['spin', 'ticker'], isStatic: false }]);
	expect(() => variants(knobs, ['nope'])).toThrow('unknown knob');
});

test('summarise: median and spread', async () => {
	expect(summarise([30, 10, 20])).toEqual({ median: 20, min: 10, max: 30 });
	expect(summarise([10, 20]).median).toBe(15);
	expect(summarise([5])).toEqual({ median: 5, min: 5, max: 5 });
});

test.skipIf(process.platform === 'darwin')('perf refuses to run off macOS', async () => {
	const r = await wdk(['perf']);
	expect(r.err).toContain('macOS only');
	expect(r.code).toBe(2);
});
