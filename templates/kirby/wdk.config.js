export default {
	pages: { start: ['/'] },
	engines: { ci: ['chromium', 'firefox', 'webkit'], local: ['chrome', 'firefox', 'webkit'] },
	viewports: [[390, 844], [1440, 900]],
	compat: { css: ['assets/css/*.css'], targets: 'defaults', allow: [] },
	// deploy: { host: 'SITE-deploy@HOST', dir: '.wdk/release', build: 'just build' }, // vps kind "kirby"; see docs/reference.md#deploys
	// content: { targets: {} }, // root@HOST:/srv/sites/D/shared/content per site; `wdk content`, see docs/reference.md#content
	proxy: { block: ['panel', 'api', '*.php'] },
};
