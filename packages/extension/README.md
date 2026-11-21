# Dash Sites extension

Maps `http(s)://<name>.dash/` to `https://<name>.<gateway>/`, where the
gateway's shell fetches the site from Dash Platform and verifies it in the
browser. The toolbar button asks Dash Platform again with the extension's own
copy of the SDK and compares the answer with the page.

```sh
npm ci && npm run build
# packages/extension/build/chrome, packages/extension/build/firefox, and a zip of each
```

Load `build/chrome` unpacked from `chrome://extensions`, or `build/firefox`
from `about:debugging`. `npm run e2e:extension` drives the Chromium build
against a live name.

## Permissions

| Permission | Why |
| --- | --- |
| `declarativeNetRequest`, host access to `*.dash` | Redirect `.dash` navigations to the gateway |
| `webNavigation` | Chrome turns a bare `alice.dash` into a search; this catches that search. Optional in settings |
| `activeTab`, `scripting` | When the button is clicked, read what the current tab was served, to compare it with Dash Platform |
| `storage` | Settings |

The extension sends nothing anywhere except proof queries to Dash Platform
nodes and the SDK's quorum key service, and only when the button is opened.

## Publishing to the stores

These need the publisher's own accounts.

**Chrome Web Store**

1. Register at https://chrome.google.com/webstore/devconsole (one-time fee).
2. "New item", upload `dash-sites-extension-chrome-<version>.zip`.
3. Listing: description from `static/manifest.json`, screenshots of a site and
   of the popup (1280×800), the 128 px icon from `static/icons`.
4. Privacy: single purpose "open and verify websites published on Dash
   Platform names"; justify each permission with the table above; declare
   that no user data is collected.
5. Submit for review. `webNavigation` and `scripting` usually draw a question;
   the answers are in the table.

**Firefox Add-ons**

1. Sign in at https://addons.mozilla.org/developers/.
2. "Submit a New Add-on", upload `dash-sites-extension-firefox-<version>.zip`.
   The add-on id is `dash-sites@thepasta.org`.
3. The bundle is minified, so attach the source (this repository at the
   release tag) and the build command `npm ci && npm run build`.
