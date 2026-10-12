// Preloaded before every test file (bunfig.toml): tests that launch browsers in-process
// need the Linux browser path set before Playwright is imported, as bin/wdk.js does.
import { linuxBrowsers } from '../lib/browsers.js';
linuxBrowsers();
