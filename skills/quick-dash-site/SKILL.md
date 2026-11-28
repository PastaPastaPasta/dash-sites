---
name: quick-dash-site
description: Turn a one-line description into a live website on a .dash name (https://<name>.dash.site) in a couple of minutes. Generates a small static site, shows the publish cost, signs in with DashPay by QR code and Open in DashPay link, publishes to Dash Platform mainnet, and prints the live URL. Use when someone asks to make, build, or publish a dash.site, or a website on their .dash name, from a short description.
---

# Quick dash.site

From one sentence to a live `https://<name>.dash.site/`. The site is stored on Dash Platform under a `.dash` name the user already owns in DashPay. The user approves once in DashPay: the wallet gives a key that can only write dash.site records, with a 0.2 DASH allowance. No seed or private key is ever typed, pasted, or shown.

Work fast. The goal is a live site within a couple of minutes of the request, with one wallet scan in the middle.

## What you need from the user

1. **The description** (one line is enough).
2. **The `.dash` name** to publish on. It must already be registered to the identity in their DashPay wallet. This skill never registers names. If they don't give one, ask for it in one short question. Publishing replaces whatever site that name serves now; say so in the same line as the cost.

Requirements: Node.js 22 or later, `git` and `npm`, and network access to Dash Platform. The first run builds the dash-sites CLI once, which takes about a minute.

## Steps

Set `QDS=<this skill's directory>/scripts/quick-dash-site.mjs`.

### 1. Make the site (about 30 seconds)

Create a fresh folder such as `./<name>-site/`, outside any folder that holds secrets. Write a single `index.html` that makes the description real and delightful. Make it a page someone would screenshot, not a template.

- One file, with inline CSS and any JS inline. No external fonts, images, CDNs or trackers. Draw visuals with CSS, inline SVG or emoji. Keep it under about 40 KB, so it costs a few hundredths of a DASH.
- Follow the visitor's theme: put `<meta name="color-scheme" content="light dark">` in the head, set `color-scheme: light dark` on `:root`, and give colours for both themes under `prefers-color-scheme`.
- Make it mobile-first and responsive: `<meta name="viewport" content="width=device-width, initial-scale=1">`, no horizontal scroll at 360px, readable at desktop width.
- Add `<title>`, a meta description, and an inline SVG favicon (`<link rel="icon" href="data:image/svg+xml,...">`).
- Use no `<a download>`, forms that POST, or service workers. dash.site serves static files only.
- A small footer line such as "Stored on Dash Platform · <name>.dash" is a nice touch.

If the description is gibberish or keyboard-mash, have fun with it: treat the text as the brief, for example a page that decodes it, sets it to music, or celebrates it. Don't refuse over nonsense input. The usual content limits still apply, because the site is public and permanent: no impersonation, phishing, or private details about real people.

### 2. Cost, then QR and button

```sh
node "$QDS" start ./<name>-site --name <name>
```

This prints what the name serves now, the size and the **estimated cost**, then starts the DashPay sign-in. It prints a terminal QR code, the `Open in DashPay` link, and the expiry time (10 minutes). The sign-in keeps waiting in the background after the command returns.

Then, in your reply to the user, show these, keeping the text around them short:

1. The estimated cost, and which name it replaces, in one line.
2. The QR code: copy the block between the triple backticks exactly, inside a code block.
3. The button: the markdown link `[Open in DashPay](dashpay://connect?...)` exactly as printed. Also give the raw `dashpay://` link on its own line, for frontends that don't make custom-scheme links clickable.
4. "Scan with DashPay (More → Tools → Connections → Scan QR) or tap Open in DashPay, then approve. Expires at <time>."

Always show the QR code and always show the button, on every device and frontend. If the frontend can show images, you may also show the SVG at the printed `QR code image:` path, but never instead of the text QR code. Showing it is fine: it holds only the public sign-in request.

If `start` says the user is already signed in, there's no QR code and no wallet approval. Show the cost and what it replaces, and get a clear yes from the user before step 3. Pass `--fresh` to make it ask the wallet again.

### 3. Wait, publish, verify

Right after showing the QR code, in the same turn, run:

```sh
node "$QDS" finish ./<name>-site --name <name>
```

It waits for the wallet approval, publishes with brotli packing, checks the new record on Platform with proofs, and prints `LIVE: https://<name>.dash.site/`. Run it in the background and wait for it to finish (the code lives 10 minutes, which is longer than some tool timeouts). If it gets cut off anyway, run `finish` again: the sign-in keeps waiting on its own, and a finished sign-in is saved. If your frontend can't show text while a command runs, end the turn after the QR code and run `finish` when the user says they approved.

Keep the final message short: the live link on its own line, then one line on what was built and what it cost. Skip the allowance, the revision number and next steps unless the user asks.

### If something goes wrong

- **The code expired, or the wallet said it was used or invalid:** run `start` again, which replaces the old request, and show the new QR code and button.
- **"the answering wallet … does not own <name>.dash":** the user approved with a wallet whose identity doesn't own that name. Ask which name their DashPay identity owns.
- **"does not resolve to it yet":** the publish went through, but the node answering was behind. Don't publish again; wait a minute and check with `resolve`.
- **Insufficient balance or allowance:** the identity needs more credits, or the key's allowance has run out. Tell the user. Top-ups are in the `dash-sites` skill (`skills/dash-sites/SKILL.md`, Path B).
- **"not registered":** the name doesn't exist. This skill never registers names; send the user to DashPay to register one.

## Rules

- Mainnet by default (`--network testnet` publishes to `https://<name>.id.dashhq.org/` for rehearsals).
- Never print, log, or commit the saved sign-in (`session.*.json` in `$DASH_SITES_CONFIG_DIR`, default `~/.config/dash-sites/`). The state folder (`$XDG_STATE_HOME/quick-dash-site/`, default `~/.local/state/quick-dash-site/`) holds only the request, its QR code and the login log; don't commit it either. Keep the site folder free of secrets: everything in it is published publicly and permanently.
- Publishing again later costs only the changed chunks: edit `index.html` and run `finish` again, with no new scan while the sign-in is valid (90 days).
- To sign out on this machine, run `node "$(node "$QDS" cli)" logout --network mainnet`. To revoke the key at once, remove "Dash Sites" in DashPay → Connections.

For bigger sites (multiple files, assets, cost tuning, registering names, funding a new identity), use the full `dash-sites` skill in this repository.
