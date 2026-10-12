export default {
	pages: { start: ['/'] },
	engines: { ci: ['chromium', 'firefox', 'webkit'], local: ['chrome', 'firefox', 'webkit'] },
	viewports: [[390, 844], [1440, 900]],
	compat: { css: ['src/*.css'], targets: 'defaults', allow: [] },
	// deploy: { host: 'SITE-deploy@HOST', dir: '_site' }, // see docs/reference.md#deploys
};
