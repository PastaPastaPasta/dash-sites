# Agent notes for dash-sites

## Every dash.site page follows the system theme

Every page dash.site shows must follow the visitor's light/dark setting: the landing page, the loading page and its errors, pages the worker generates (not found, unavailable), `/new`, and the notice.

- Declare both themes: `<meta name="color-scheme" content="light dark">` in the `<head>`, and `color-scheme: light dark` on `:root`.
- Prefer the system colours (`Canvas`, `CanvasText`, `GrayText`) for page background and text, so pages look native, the way a plain page does in that browser. Branded palettes are fine only with a light and a dark variant under `prefers-color-scheme`.
- Don't hard-code one theme. A fixed colour is fine only where the content needs it: the QR code's white backing on `/new`, which scanners need, and the white behind the preview of a visitor's own site, which is how that site renders.
- Check contrast in both themes, including text on accent-coloured buttons.
- UI changes come with light and dark screenshots on desktop and phone.

## Stored formats

Read [docs/VERSIONING.md](docs/VERSIONING.md) before changing anything stored on Platform or in a site: the contract, the site record, chunks, content URIs, the manifest, or what the builder saves.

- Take a version number in its registry in the same PR that first writes it, and add a frozen fixture for it under `packages/core/test/fixtures/formats/`.
- Never edit or regenerate a fixture, and never drop the reader for a version that reached mainnet.
- Writers write the lowest version that holds what they store. Readers refuse a newer version as a whole, with the "needs a newer version" message.
- Keep `/sw.js` at that path and scope, and uncacheable: the kill switch depends on it.

## Wording

dash.site is a static page/site. Don't call it a gateway in anything users see, in PRs or in the README. (`packages/gateway`, the server behind `id.dashhq.org`, really is one.)
