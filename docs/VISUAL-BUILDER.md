# Visual site builder and Dash widgets

Status: proposal, nothing built. Date: 2026-11-25. Wanted from Pasta: yes, no,
or change X (the open calls are listed in [§8](#8-decisions-wanted)).

Today a site is either one page written in a form (title, tagline, Markdown,
links, three looks) or a folder of code someone wrote elsewhere and uploaded.
The goal is a builder where people assemble a site by pointing and typing,
and can drop in things only Dash can do: comments signed with a Dash
username, polls with one vote per username.

## Recommendation

1. **Embed [Puck](https://github.com/puckeditor/puck) (MIT) as the editor**
   in the existing builder, in place of the "Write a page" form. Puck supplies
   the editing surface (drag and drop, click-to-edit text, undo, a field
   panel, a phone layout). We supply the blocks, the themes and the code that
   turns a page into HTML, so we decide every byte that is stored.
2. **Keep "Upload a site" as the free-form path.** Anything Framer, Carrd,
   Publii, Webflow or a developer can export as static files already
   publishes through it.
3. **Make widgets independent of the editor.** A widget is one HTML tag
   (`<dash-comments>`, `<dash-poll>`). The builder inserts it from a block;
   an uploaded or hand-written site adds the same tag by hand. The code
   behind the tag is served by the shell host, not stored in each site, so a
   widget adds about 100 bytes to a site.
4. **One new data contract for widget data**, separate from the `dash-sites`
   contract, in which Dash Platform itself checks who may write what.
5. **Start small.** Milestone 1 is the editor with eight blocks on the
   testnet builder: no widgets, no contract, nothing on mainnet.

The SDK-from-npm idea is not needed for any of this (see
[§5.4](#54-the-sdk-from-npm-idea)); it stays worth landing for other reasons.

## 1. What a builder must satisfy here

| Constraint | Where it comes from |
| --- | --- |
| Runs as static files in the browser, with no account and no server | The builder is static files at `dash.site/new`; there is no publishing server |
| Passes the builder's Content-Security-Policy: scripts from its own host only, no `eval`, no third-party requests | `packages/builder/build.mjs`; the page holds a key that can publish |
| Output is plain static files, and small | Storage is paid once at about 0.3 DASH per MB (0.275 per MB of bytes plus 0.00028 per 14.7 KB chunk) |
| Extensible with our own blocks | Comments, polls and whatever follows |
| MIT-compatible licence | The repository is MIT |
| Usable on a phone | Sign-in is a mobile wallet; on a phone the builder already hands off to the wallet app |

## 2. Options surveyed

Versions and licences are from npm and GitHub on 2026-11-25.

| | Licence | What it is | Verdict |
| --- | --- | --- | --- |
| Carrd, Framer, Webflow, Wix | closed, hosted | Polished builders that host the result themselves | Cannot be embedded or extended. Their static exports can be uploaded today. |
| [Publii](https://github.com/GetPublii/Publii) 0.48 | GPL-3.0 | Desktop app (Electron) that generates a blog from themes | Not a web page, and GPL. A good fit for blogs as a separate tool: its output folder publishes through the CLI or upload. A plugin that inserts the comments tag is cheap to add later. |
| [GrapesJS](https://github.com/GrapesJS/grapesjs) 0.23.9 | BSD-3-Clause | Free-form HTML/CSS page editor, framework-free, large plugin ecosystem | The runner-up. Prototyped; see §3. |
| [Silex](https://github.com/silexlabs/Silex) 3.10 | AGPL-3.0 | GrapesJS plus a Node server for storage and hosting connectors | Needs a server and is AGPL. |
| [Webstudio](https://github.com/webstudio-is/webstudio) | AGPL-3.0 | Webflow-like, with a server and a database | Needs a server and is AGPL. |
| [Puck](https://github.com/puckeditor/puck) 0.24.2 (`@puckeditor/core`) | MIT | Block editor for React: you write the blocks, it provides the editor | **Recommended.** Prototyped; see §3. |
| [Craft.js](https://github.com/prevwong/craft.js) 0.2.12 | MIT | Toolkit for building your own editor in React | Last release February 2025; we would be building most of the editor. |
| [VvvebJs](https://github.com/givanz/VvvebJs) 2.0 | Apache-2.0 | Bootstrap 5 page builder | Output depends on Bootstrap's stylesheet, paid for by every site. |
| [Editor.js](https://github.com/codex-team/editor.js) | Apache-2.0 | Block text editor | Writes articles, not pages. Could back a blog block later. |
| Growing the current form ourselves | n/a | Add a section list to `template.ts` | No dependency and trivially phone-friendly, but we would write drag and drop, undo, inline editing and the field UI that Puck already has. The fallback if Puck disappoints. |

The real choice is between two kinds of editor:

- **Free-form (GrapesJS)**: the user edits HTML elements and CSS properties
  directly. Anything is possible. The output is whatever the user made, the
  stock interface exposes margins, flexbox and selectors, and there is no
  phone layout.
- **Blocks (Puck)**: the user stacks sections and fills in fields. Less is
  possible. Every page is built from markup we wrote, so it is small,
  responsive and accessible by construction, and a widget is one more block.

Sites under a DPNS name are mostly personal and project pages, which is what
Carrd serves with a block model. People who want free-form design keep the
upload path, with any tool they like.

## 3. What the prototypes measured

Two throwaway pages, one per engine, each building the same reference page (a
picture, a heading, a tagline, a 75-word paragraph, four links, three columns,
a poll tag, a comments tag, a footer). Both ran in headless Chromium, served
with the exact Content-Security-Policy of `dash.site/new`, at 1280×800 and at
390×844 with touch. Sizes are brotli quality 11.

| | GrapesJS 0.23.9 | Puck 0.24.2 + React 19 |
| --- | --- | --- |
| Editor script | 1.15 MB, 239 KB compressed | 1.28 MB, 321 KB compressed |
| Editor stylesheet | 61 KB, 11 KB compressed | 117 KB, 14 KB compressed |
| Under the builder's CSP | Runs. Its toolbar icons are a font fetched from cdnjs, which the policy blocks, so the icons are blank until bundled locally | Runs, no violations (using its `no-external.css`) |
| Requests to other hosts | cdnjs (icon font). With default settings it also POSTs the page's host name and its version to `app.grapesjs.com`; `telemetry: false` turns that off | None |
| At phone width | The desktop layout squeezed: the side panel is about 60 px wide, with no adaptation | Adapts: canvas on top, Blocks / Outline / Fields tabs below; tapping a block selects it and opens its fields |
| Reference page, published HTML and CSS | 2.8 KB, 972 B compressed | 2.3 KB, 943 B compressed |
| What a later edit needs | Its project file: 5.5 KB, 1.3 KB compressed (larger than the page) | Our page model: 1.5 KB, 596 B compressed |
| Reopening from the published HTML alone | Widget tags came back as widgets. The CSS came back rewritten into longhand (1.2 KB became 2.6 KB) and the body's styles were lost, so a republish changes bytes that were already paid for | Not applicable: the model is the source, the HTML is derived |
| How output grows | One CSS rule per styled element: four identical link styles are four rules | One shared stylesheet per theme; a fifth link adds only its own text |
| Inside a sandboxed frame (no access to the page holding the key) | Not tested | Works with Puck's inline preview; fails with Puck's own nested preview frame |

The prototype pages were throwaway and are not part of this change. What they
do not show: drag and drop on a real phone (only tap and field
editing were exercised, in emulated touch), Safari and Firefox, long pages,
and how the stock GrapesJS interface could be reshaped with effort. For one
text page the two outputs cost the same, so output bytes do not decide this.
The phone layout, the absence of outside requests, the predictable output and
the size of the editing state do.

## 4. Why Puck, and what it costs

For:

- MIT and active (0.24.2 was released on 2026-11-23; 13.7k stars). The
  editor calls no service.
- A block is a small object: its fields and a render function. The
  prototype's comments block is five lines.
- Text is edited in place on the canvas, checked in the prototype.
- We own the output. The same render functions draw the canvas and produce
  the published HTML, so what is edited is what is stored.
- The page model is a short JSON list of blocks. It is ours, versioned by us,
  and can be read without Puck.

Against:

- **It is pre-1.0** and renamed its package this year (`@measured/puck` to
  `@puckeditor/core`). Pin the exact version, and keep our model independent
  of Puck's internals so the editor can be swapped without touching
  published sites.
- **It brings React and about forty dependencies** (drag and drop, rich
  text, popovers) into a page that holds a publishing key. §5.1 answers this
  by keeping the editor away from the key.
- **No free-form layout.** That is the design, but it is a limit: a user who
  wants a button eleven pixels to the left has to use the upload path.

If the answer is "I want Framer-like free-form editing", the engine becomes
GrapesJS and the work shifts: a custom interface over its APIs (the stock one
is not for non-coders and has no phone layout), storing its project file,
bundling its icons, and turning its telemetry off. §5.2 to §5.5 do not change.

## 5. Architecture

### 5.1 Editor

- **Where**: a lazily loaded part of `packages/builder`, replacing the "Write
  a page" tab. Sign-in, name choice, cost, publish and "Upload a site" stay as
  they are.
- **Away from the key**: the editor loads in a sandboxed frame with no access
  to the page around it, and exchanges only the page model with it by
  message. The page that holds the key never loads Puck, React or their
  dependencies. The prototype confirmed Puck runs this way with its inline
  preview; its nested preview frame does not, so themes must respond to the
  width of their container, not of the window. If that proves too limiting in
  milestone 1, the fallback is no sandbox and the existing rule that the key
  on `dash.site/new` is dropped after each publish.
- **Blocks for milestone 1**: profile header (picture, name, tagline), text
  (headings, bold, links, lists), link list, image, columns of cards, button,
  divider, footer. The three existing looks (Paper, Night, Signal) become
  themes: a set of colours and a type stack applied to every block.
- **Page model**: `{ v, theme, pages: { "/": [ { type, props } … ] } }`.
  Drafts are saved in the browser. On publish the model is stored once as a
  small file beside the pages, so the owner can reopen and edit the site from
  any device. On the reference page that file is 596 bytes compressed, under
  0.0002 DASH.
- **Rendering**: HTML with one inline stylesheet holding only the rules of
  the blocks used. No script unless a widget is on the page. Text entered by
  the user is escaped; rich text is cut down to a short list of tags.
- **Images**: the largest cost by far, so they are resized and re-encoded to
  WebP in the browser before they enter the page, with the stored size and
  its price shown per image.
- **Fonts**: system font stacks. Web fonts are deferred (§5.4).
- **Cost meter**: the existing estimate, always visible while editing, split
  into text and images.
- **Existing drafts** of the current form convert to a header, a text block
  and a link list.

### 5.2 Widgets

A site that wants comments contains this and nothing else:

```html
<dash-comments thread="/"></dash-comments>
<script src="/.well-known/dash/widgets.js" async></script>
```

- **The loader** (`widgets.js`) is answered by the shell on every site's own
  address, like `/.well-known/dash/site.json` today. It is not stored in the
  site, so it costs nothing and can be improved without anyone republishing.
- **The widget itself runs in a frame on its own address**,
  `w.<shell domain>` (`w.dash.site`). A DPNS label has at least three
  characters, so `w` can never be someone's name and shadows no site. It is
  static files, as the builder is: on `dash.site`, one more assets-only
  Cloudflare Worker route.
- **Why a frame**: a site's own script is untrusted. A visitor's key must
  not be readable by the site they are commenting on. In the frame the key
  lives under `w.<domain>`, which no site can read.
- **Which site a widget belongs to** is taken from the browser's report of
  the embedding page's address, never from anything the page says. A site can
  therefore only ever cause comments or votes on itself.
- **Loading**: the frame is created when the widget scrolls into view. It
  needs the SDK's WebAssembly (5.7 MB), the same file the shell has just
  downloaded from the same host to show the site, so it is normally already
  in the browser's cache.
- **Reading** needs no sign-in: comments and tallies are read from Dash
  Platform with proofs, and shown as plain text.
- **Appearance**: the tag passes colours and a font stack; the frame applies
  a fixed list of them.

Later, the shell's own worker (which already has the SDK running) can answer
reads directly so that only writing needs the frame. Because the loader comes
from the shell, that changes no published site.

### 5.3 Contract

One new contract, working name `dash-sites-social`, registered by the same
identity that owns the `dash-sites` contract (the wallet rule in §5.5 needs
that). It is separate on purpose: a key for commenting must never be a key
that can publish or replace a site.

| Type | Written by | Fields | What Dash Platform enforces |
| --- | --- | --- | --- |
| `comment` | any identity with a DPNS name | `site` (the site record's id), `thread` (a page path or a key the author of the page chose), the commenter's name, `text`, optional `replyTo` | The site record exists. The commenter owns the name they comment as. Cannot be edited; its author can delete it. |
| `hide` | the site's owner | `site`, and a comment id or an author id | Only the identity that wrote the site record can write one. |
| `poll` | the site's owner | `site`, `slug`, `question`, `options` (2 to 8), `closesAt` | Only the site's owner can open one. One per slug per site. Never edited or deleted, so the question and options cannot change after votes. |
| `vote` | any identity with a DPNS name | `poll`, `choice`, the voter's name | The poll exists and has not closed. One vote per identity per poll. Tallies come from a counted index, so a count is one proved query, not a download of every vote. |

- These rules use `refersTo` (the mechanism PR #14 uses to tie a site record
  to its name's owner), unique indexes and countable indexes. All three are
  in the document schema of Platform 5.0.3. Both networks report protocol
  14. This table is a sketch: the exact schema has to be
  rehearsed on testnet the way PR #14's was, including the refused writes.
- **Depends on PR #14.** `comment.site` points at a site record that can
  never be deleted, which is only true of the new contract. A side effect
  worth having: a buyer's site record is a new document, so a name that is
  sold starts with empty comment threads.
- **Moderation**: the site's owner hides a comment or mutes an author with a
  `hide` record, and the widget does not show what its site's owner has
  hidden. Authors delete their own comments. Nobody else can remove anything
  from Platform, the same stance as the `dash-sites` contract. A hosted
  `w.` frame can decline to display an author, as hosted shells can decline
  to serve a name.
- **Fixed at registration**: each type's indexes, whether its documents can
  be edited or deleted, and whether the contract has moderators. New types,
  new optional fields and longer limits can be added later.
- [Pollr](https://github.com/PastaPastaPasta/pollr) already stores polls and
  ballots on Platform. Its ballot design is the starting point for `vote`;
  what differs here is that a poll belongs to a site and only that site's
  owner can open it.

### 5.4 The SDK-from-npm idea

The idea: do not store the SDK in a site; name the npm file and its hash,
and let the browser fetch it from an npm mirror and check it. The branch
`feat/external-assets` already implements this (manifest version 2: package,
exact version, path, SHA-384; fetched from jsDelivr, then unpkg).

- **Widgets do not need it.** In §5.2 the SDK is a static file of the shell
  host, already downloaded to show the site. No site stores it and no npm
  mirror is contacted.
- **It still matters for uploaded sites that are apps**: storing the SDK
  would cost about 1.7 DASH per site, against nothing when named by hash.
- **It could give the builder web fonts for free**: fonts are npm packages
  too. The price is that visitors' browsers contact jsDelivr or unpkg, which
  today's sites never do (`e2e/shell.mjs` asserts it). That is a product
  call, so fonts stay on system stacks until it is made.

Recommendation: land `feat/external-assets` on its own merits; nothing here
waits for it.

### 5.5 Identity

- **Building and publishing**: unchanged. A wallet sign-in gives the builder
  a key that can only write `dash-sites` documents.
- **Commenting and voting**: the frame shows the same wallet sign-in (QR
  code, or a button on a phone), asking for one key that can only write
  `dash-sites-social` documents, with a proposed limit of 0.05 DASH and 90
  days. The wallet's owner sees and can change both. The frame then shows
  "answered as alice.dash, continue?" as the builder does. There is no
  paste-a-private-key option inside a widget.
- **One approval covers every site** on that shell host, because the key is
  kept under `w.<domain>` until it expires or the visitor signs out.
- **The owner's side** (opening a poll, hiding a comment) needs a
  `dash-sites-social` key as well. App Connect lets one request carry several
  keys, provided the contracts share an owner, so the builder asks for both in
  a single approval when a page contains a widget.
- **Usernames** are not looked up when comments are shown: each comment
  carries its author's name, and Platform refused it unless the author owned
  that name when writing.

### 5.6 Costs

| What | Who pays | About |
| --- | --- | --- |
| A one-page site of text | owner, once | 0.002 DASH (PR #14 measured 0.0016 for two chunks) |
| Its page model, for later editing | owner, once | under 0.0002 DASH |
| A 60 KB photo | owner, once | 0.018 DASH |
| A 200 KB photo | owner, once | 0.059 DASH |
| A widget on a page | owner, once | about 100 bytes: the tag and the loader line |
| A comment or a vote | the commenter or voter | to be measured; a 100-byte document costs 0.000265 DASH today, and these carry more indexes. Deleting refunds most of the storage part |
| Registering the social contract | Pasta, once per network | to be measured on testnet; PR #14's two-type contract cost 0.18 DASH there, and this one has four types |
| The editor, the widget code, the SDK | nobody | static files of the shell host, not on Platform |

A photo costs roughly ten to thirty times what the rest of a page does, which
is why the image step and the meter are in milestone 1. That a comment costs
its author something, however little, is also the first line of spam control.

## 6. Risks

| Risk | What limits it |
| --- | --- |
| Puck changes or stalls before 1.0 | Exact version pinned; our model and renderer do not depend on it; the fallback is our own section list |
| A compromised editor dependency steals a publishing key | The editor runs in a sandboxed frame and never sees the key (§5.1). The builder's policy must allow connections to any HTTPS host, because Platform nodes are bare addresses, so isolation is the control, not the policy |
| A site tricks a signed-in visitor into clicking inside the widget frame | A site can only affect its own threads and polls; a vote asks for confirmation naming the site; the key has a spending limit. Residual: a visitor can be made to vote in that site's own poll |
| Comment text attacks the frame | Text is rendered as text, never as HTML. The frame is on its own address, apart from the builder and from every site |
| Spam and abuse in comments | Each comment costs its author and needs a name; owners hide and mute; hosted frames can decline an author. Nothing can be forced off Platform, and a comment is public for as long as its author leaves it |
| Polls are not sybil-proof | One vote per identity with a name, and both cost little. Polls measure sentiment; say so in the widget. A later rule could admit only names older than the poll |
| The contract's terms are permanent | Rehearse on testnet first, with every refused write, as PR #14 did. Mainnet registration is a separate decision |
| One sign-in for all sites stops working | It relies on `dash.site` not being on the Public Suffix List. Once listed, browsers give the frame separate storage per site, and a visitor signs in per site unless the frame asks for storage access |
| Wallets and a second app | The flow is the one the builder uses today. How DashPay presents "Dash Sites comments" beside "Dash Sites", and a two-key request, needs a test on both wallets |
| Depends on PR #14 and its mainnet contract | Milestone 1 does not. Comments wait for the new contract on each network |
| People expect free-form design | The upload path stays, and widgets work in uploaded sites |

## 7. Phases

Each milestone ends on testnet and is usable on its own.

| | What ships | Done when |
| --- | --- | --- |
| **M1: Blocks** | Puck in the testnet builder with the eight blocks and three themes of §5.1, the image step, the cost meter, drafts, and reopening a published site for editing. No widgets, no contract, nothing on mainnet | The reference page is built and published on a phone and on a desktop, costs at most 0.002 DASH, and reopens for editing on another device. The builder's policy is unchanged and it makes no request to another host. The existing end-to-end tests pass |
| **M2: Comments** | The social contract on testnet (all four types, rehearsed), the loader in the shell, the `w.` frame, reading, signing in, posting, deleting, and hiding by the owner. A Comments block | A comment posted from DashPay on one testnet site appears there, cannot be posted under a name the author does not own, and can be hidden by the owner. Measured cost per comment is in the docs |
| **M3: Polls** | Opening a poll from the builder, voting, proved tallies, closing. A Poll block | A second vote from the same identity is refused by Platform, and a vote after closing is refused |
| **M4: Mainnet** | The builder at `dash.site/new`, the `w.dash.site` route, the social contract on mainnet | After PR #14's contract is on mainnet and Pasta approves the registration, with its cost quoted from testnet |
| Later | Several pages and a blog list, a template gallery, web fonts, more widgets (guestbook, reactions, a "pay alice.dash" button), a Publii guide, reads answered by the shell | |

M1 is deliberately the part with no permanent consequences: no contract, no
visitor keys, no new address. It answers whether people can build a site
they like without writing code.

## 8. Decisions wanted

1. **Blocks (Puck) or free-form (GrapesJS)?** Recommended: blocks, with
   upload as the free-form path.
2. **Go for M1 on the testnet builder?**
3. **Should the social contract have moderators** who can delete any comment,
   or none, as `dash-sites` has? It cannot be added after registration.
   Recommended: none; owners hide, hosted frames decline.
4. **May builder-made sites load fonts from npm mirrors**, which lets
   visitors' browsers contact jsDelivr or unpkg? Recommended: not yet.
5. **`w.<domain>` as the widget address**, served as static files beside the
   shell. The alternative is to publish the widget as a Dash Site of its own,
   which is purer and slower and needs `feat/external-assets`.

## 9. Not in this proposal

Free-form layout in our own editor, a server of any kind, comments on
websites that are not Dash Sites, private or paid content, token-gated
pages, weighting votes by masternode or balance, and anything on mainnet
before M4.
