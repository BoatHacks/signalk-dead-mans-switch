# Vendored webapp dependencies

`htm-preact-standalone.module.js` is htm's `preact/standalone` build
(from the `htm` npm package, version 3.1.1), vendored here as a static
file rather than loaded from a CDN at runtime.

## Why vendored instead of loaded from a CDN

The browser rendering this webapp is very often talking only to the
local SignalK server with no wider internet access (e.g. underway with
no cellular/wifi uplink). Since ES module `import` statements are all
resolved *before* any code in the module runs, a single failed CDN
import silently aborts the entire script - the page just renders its
background color forever, with no visible error unless the browser's
dev tools happen to be open. For a dead man's switch specifically,
that failure mode is unacceptable: the ack button is the one thing
that must always work. Vendoring removes the failure mode entirely -
everything the webapp needs ships with the plugin.

## Why this one file specifically

`htm`'s `preact/standalone` build is fully self-contained - it bundles
Preact core, `preact/hooks`, and htm's tagged-template compiler into a
single file with zero external imports. It exports `h`, `html`
(already bound), `render`, `Component`, and the hooks used by this
webapp (`useState`, `useEffect`, `useRef`) - see the `export { ... }`
statement at the end of the file for the full list.

## Updating

To refresh to a newer `htm`/Preact release:

```
npm install htm@<version> --no-save
cp node_modules/htm/preact/standalone.module.js public/vendor/htm-preact-standalone.module.js
```

Then update the version note below and re-run the plugin's test suite.

Currently vendored: `htm` 3.1.1 (which bundles Preact 10.19.3).

## Licenses

This file is built from two upstream projects:
- [`htm`](https://github.com/developit/htm) - Apache License 2.0
- [`preact`](https://github.com/preactjs/preact) - MIT License

Full license texts: `htm-LICENSE` and `preact-LICENSE` in this directory.
