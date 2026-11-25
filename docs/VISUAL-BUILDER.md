# Visual site builder and Dash widgets

Status, 2026-11-25: milestone 1 (the block editor, §5.1) and files kept
outside Platform ([BULK-STORAGE.md](BULK-STORAGE.md)) are built in this PR.
Widgets (§5.2, §5.3, §5.5 and milestones 2 to 4) are still a proposal, with
nothing built. The open calls are listed in [§8](#8-decisions-wanted).

Decided in review (Pasta, 2026-11-25): the shell that loads sites stays
simple and unchanging, so that others can run it. It serves no widget code.
Widget code is kept on Dash Platform and committed there. §5.2 and §5.4 are
written to that rule; the first draft had the shell host serve the widgets.

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
   an uploaded or hand-written site adds the same tag by hand.
4. **Keep all widget code on Dash Platform, and leave the shell alone.** The
   part that shows comments is a small script stored in the site. The part
   that signs in and writes is a Dash Site of its own, opened in a tab.
5. **One new data contract for widget data**, separate from the `dash-sites`
   contract, in which Dash Platform itself checks who may write what.
6. **Start small.** Milestone 1 is the editor with eight blocks on the
   testnet builder: no widgets, no contract, nothing on mainnet.

Widgets need the SDK in the page, and it is too large to store in every site.
A site now takes it from npm by hash instead (see
[§5.4](#54-the-sdk-by-hash-from-npm)), which was the one addition to the
shell this plan needed.

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
- **Away from the key**: proposed as a sandboxed frame with no access to the
  page around it. **Not built in milestone 1**, which took the fallback: the
  editor runs in the builder's own page, so that text is edited in place and
  images share one store with the rest of the builder. What limits the risk
  today: Puck and React are pinned to exact versions and bundled at build
  time, nothing is fetched from another host, the editor's code loads only
  when the editor is opened, and on `dash.site/new` the key is dropped after
  each publish and after ten idle minutes. The sandboxed frame is still the
  aim (§6, §7).
- **Blocks for milestone 1**: profile header (picture, name, tagline), text
  (headings, bold, links, lists), link list, image, columns of cards, button,
  divider, footer.
- **Looks**: a set of colours and a type stack applied to every block. A new
  page starts on **Auto**, which is light for a visitor whose system is light
  and dark for one whose system is dark. Paper, Night and Signal are looks an
  author picks on purpose, and they stay as picked for every visitor.
- **Light and dark**: everything on dash.site follows the system setting. The
  builder and the editor do (Puck's colours are mapped onto the builder's
  own), and so does a page unless its author picked a look.
- **Page model**: `{ v, theme, pages: { "/": [ { type, props } … ] } }`.
  Drafts are saved in the browser. On publish the model is stored once as
  `/dash-site.json`, so the owner can reopen and edit the site from any
  device. On the reference page that file is 693 bytes compressed, about
  0.0002 DASH.
- **Rendering**: HTML with one inline stylesheet holding only the rules of
  the blocks used. No script unless a widget is on the page. Text entered by
  the user is escaped; rich text is cut down to a short list of tags.
- **Images**: the largest cost by far, so they are resized and re-encoded to
  WebP in the browser before they enter the page, with the stored size and
  its price shown per image. An owner with many or large images can keep
  them off Platform instead, from a panel in the same step
  ([BULK-STORAGE.md](BULK-STORAGE.md)). Reopening a site fetches such images
  from their places. It keeps them there only when the person reopening is
  signed in as the site's owner: anyone can publish a page that lists places
  of their choosing, so another site's places are never taken on trust.
- **Fonts**: system font stacks. Web fonts are deferred (§5.4).
- **Cost meter**: the existing estimate, always visible while editing, split
  into text and images.
- **Existing drafts** of the current form convert to a header, a text block
  and a link list.

### 5.1.1 Versions

Everything a builder-made site stores says which version of its format it
is, so that a later builder can change the format without guessing.

| What | Where its version is | Rule |
| --- | --- | --- |
| Page model | `v` in `/dash-site.json` (1 today) | Any change to the model's shape raises `v`. A builder opens every version up to its own and saves in its own. A page from a newer builder is refused with a message to reload, never half-read. A draft from a newer builder is left in the browser as it is, and nothing is saved over it |
| Draft images and remembered places | None: `dash-sites.page-images` and `dash-sites.outside` in the browser | Both are caches of what the page and the published site already say. An entry a builder cannot read is skipped, and nothing is lost that publishing or reopening does not bring back |
| Published HTML | None of its own | It is an output of the model. Republishing from a newer builder rewrites it; until then it stays exactly as published |
| Manifest | `v` (1; 2 with brotli or npm files; 3 when a file is kept outside Platform) | A writer uses the lowest version that holds the site. Version 3 readers ignore what they do not know ([BULK-STORAGE.md](BULK-STORAGE.md)). Only a change older readers must not ignore raises it |
| Widgets (proposed, §5.2) | A `v` attribute on each tag, and the version in the write page's address and messages | A site keeps the widget script it was published with. The write site answers every version it ever shipped |
| Records on Platform | The data contract | Read through `@dash-sites/core`'s resolver only, so the builder follows a contract change without changes of its own |

### 5.2 Widgets

The rule: the shell gains nothing for widgets. Every byte of widget code is
either a file in a site's proved manifest, or an npm file whose hash is in
that manifest.

A widget has two parts, because showing comments and writing them need
different things.

**Showing** is a script stored in the site:

```html
<dash-comments v="1" thread="/"></dash-comments>
<script src="/dash-widgets.js" async></script>
```

- `dash-widgets.js` is a file of the site like any other. The builder adds
  it when a page has a widget; an uploaded site includes the same file.
- It reads comments and tallies from Dash Platform with proofs and shows
  them as plain text. It starts when the widget scrolls into view.
- It holds no key, so it needs no protection from the site around it. A site
  can show whatever it likes on its own page anyway.
- It follows the visitor's light or dark setting, unless the site's author
  set a theme, which it then uses. The write page below follows the system
  setting too.
- This works on today's shell. Its worker leaves requests to other hosts
  alone, and the showcase site at `p2p.dash` already does proved reads from
  inside its page.
- A site keeps the version it was published with until its owner republishes.

**Writing** (signing in, posting, voting, hiding) is a Dash Site of its own:

- It is published under a DPNS name we register (working name
  `widgets.dash`). Its code is on Platform, committed by that name's record,
  and loaded and checked by the shell like any other site.
- Pressing "Comment" or a poll option opens it in its own tab, at
  `<widget name>.<the domain the site is on>`. The script works that address
  out from its own, so it holds on `dash.site`, on anyone else's copy of the
  shell and through the extension.
- The visitor's key is kept under that name's address, which no other site
  can read. One sign-in covers every site.
- The tab says which site and thread it is about to write to, writes, tells
  the page that opened it, and closes. The page then reads the thread again.
- The script takes the widget name as a setting, so an owner who would
  rather trust their own copy can publish one under their own name.

**Why a tab and not a frame.** Today's shell refuses to show a name in a
frame until that browser has opened it in a tab once
(`packages/shell/src/host.ts`), so that data a previous owner of the name
left in the browser can be cleared first. A tab works on the first visit
with the shell as it is. It also keeps the address in view and leaves a site
nothing to trick a click into. After that first tab the same browser will
show the widget name in a frame, so posting inside the page can be added
later, still without touching the shell. That holds while browsers treat
every name as part of one site, which ends if the domain goes on the Public
Suffix List.

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
  from Platform, the same stance as the `dash-sites` contract.
- **Fixed at registration**: each type's indexes, whether its documents can
  be edited or deleted, and whether the contract has moderators. New types,
  new optional fields and longer limits can be added later.
- [Pollr](https://github.com/PastaPastaPasta/pollr) already stores polls and
  ballots on Platform. Its ballot design is the starting point for `vote`;
  what differs here is that a poll belongs to a site and only that site's
  owner can open it.

### 5.4 The SDK, by hash from npm

Both parts of a widget run the SDK in a page: the script that shows comments
needs it to check proofs, and the write site needs it to sign. The shell's
worker has its own copy, but a page cannot use it. There were three ways to
give a page the SDK:

| | Committed on Platform | Cost | Shell |
| --- | --- | --- | --- |
| **List the npm file's addresses and its hash in the site's manifest**; the browser fetches it from an npm mirror and the shell checks it | The hash is. The bytes come from jsDelivr, then unpkg | Nothing stored | One addition: a manifest entry may say where a file is kept |
| Store the SDK in each site | Fully | About 1.7 DASH per site | Unchanged |
| Load it from jsDelivr by address, as the showcase site does today | No: the mirror decides what runs | Nothing | Unchanged |

The first is now built, as the general mechanism for keeping any large file
outside Platform ([BULK-STORAGE.md](BULK-STORAGE.md)): a file's entry lists
places, and the shell serves only bytes that match the proved hash. It says
nothing about widgets. For the SDK the places are two HTTPS addresses.

Measured on testnet, through the shell in Chromium: a site listing
`@dashevo/wasm-sdk@5.0.3/dist/raw/wasm_sdk_bg.wasm` (26.7 MB) at jsDelivr and
unpkg stores nothing for it on Platform, and the file is fetched and checked
in under 2 seconds. It does not count against the 50 MB a site may store.

Still true for widgets:

- Visitors' browsers contact jsDelivr or unpkg, which a site with every file
  on Platform never does. With widgets that becomes normal for any site that
  has one.
- A page with a widget runs a second copy of the SDK beside the worker's.
  The shell keeps the checked file for each site, so a returning visitor
  does not fetch it again.

Fonts are npm packages too, so the same mechanism could give builder-made
sites web fonts at no storage cost. That is a separate product call; fonts
stay on system stacks until it is made.

### 5.5 Identity

- **Building and publishing**: unchanged. A wallet sign-in gives the builder
  a key that can only write `dash-sites` documents.
- **Commenting and voting**: the write site shows the same wallet sign-in (QR
  code, or a button on a phone), asking for one key that can only write
  `dash-sites-social` documents, with a proposed limit of 0.05 DASH and 90
  days. The wallet's owner sees and can change both. The write site then
  shows "answered as alice.dash, continue?" as the builder does. It has no
  paste-a-private-key option.
- **One approval covers every site**, because the key is kept under the
  widget name's address until it expires or the visitor signs out.
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
| Widgets on a site | owner, once per site | the script that shows them, to be measured; at 10 KB stored, 0.003 DASH |
| A comment or a vote | the commenter or voter | to be measured; a 100-byte document costs 0.000265 DASH today, and these carry more indexes. Deleting refunds most of the storage part |
| Registering the social contract | Pasta, once per network | to be measured on testnet; PR #14's two-type contract cost 0.18 DASH there, and this one has four types |
| Publishing the write site | Pasta, per release | to be measured; at 50 KB stored, 0.015 DASH, with the previous release's storage mostly refunded |
| The SDK | nobody | named by hash, fetched from npm mirrors |
| The editor | nobody | static files of the builder, not on Platform |

A photo costs roughly ten to thirty times what the rest of a page does, which
is why the image step and the meter are in milestone 1. That a comment costs
its author something, however little, is also the first line of spam control.

## 6. Risks

| Risk | What limits it |
| --- | --- |
| Puck changes or stalls before 1.0 | Exact version pinned; our model and renderer do not depend on it; the fallback is our own section list |
| A compromised editor dependency steals a publishing key | Open after milestone 1: the editor shares the builder's page (§5.1). Exact versions are pinned and bundled at build time, the code loads only when the editor is opened, and `dash.site/new` drops the key after each publish. The builder's policy must allow connections to any HTTPS host, because Platform nodes are bare addresses, so a sandboxed frame is the real control and is still to be built |
| A site imitates the write page, or shows a sign-in code of its own | The real write page is at the widget name's address, in view in its tab, and the wallet shows what it is approving. Residual, as for the builder's sign-in today: a visitor who approves an imitation hands it a key that can comment and vote as them, up to its spending limit, until it expires or they remove it in the wallet |
| Whoever owns the widget name controls the write page for every site | Keep that identity's keys offline and never transfer the name. Every change is a new record on Platform that anyone can see. A site can point at another copy |
| Comment text attacks the page showing it | Text is rendered as text, never as HTML, and the script that shows it holds no key |
| An npm mirror is down or serves other bytes | Two mirrors, and nothing runs unless its hash matches. The widget is then missing; the rest of the site is not affected |
| Published sites keep an old copy of the script | The address the script opens and the message it gets back are versioned, and the write site keeps answering old versions |
| Spam and abuse in comments | Each comment costs its author and needs a name; owners hide and mute. Nothing can be forced off Platform, and a comment is public for as long as its author leaves it |
| Polls are not sybil-proof | One vote per identity with a name, and both cost little. Polls measure sentiment; say so in the widget. A later rule could admit only names older than the poll |
| The contract's terms are permanent | Rehearse on testnet first, with every refused write, as PR #14 did. Mainnet registration is a separate decision |
| A new tab for every comment or vote is clumsy | It is one extra step, and the place where the wallet sign-in happens anyway. Posting inside the page can follow (§5.2) |
| Wallets and a second app | The flow is the one the builder uses today. How DashPay presents "Dash Sites comments" beside "Dash Sites", and a two-key request, needs a test on both wallets |
| Depends on PR #14 and its mainnet contract | Milestone 1 does not. Comments wait for the new contract on each network |
| People expect free-form design | The upload path stays, and widgets work in uploaded sites |

## 7. Phases

Each milestone ends on testnet and is usable on its own.

| | What ships | Done when |
| --- | --- | --- |
| **M1: Blocks** | Puck in the testnet builder with the eight blocks and three themes of §5.1, the image step, the cost meter, drafts, and reopening a published site for editing. No widgets, no contract, nothing on mainnet | The reference page is built and published on a phone and on a desktop, costs at most 0.002 DASH, and reopens for editing on another device. The builder's policy is unchanged and it makes no request to another host. The existing end-to-end tests pass |
| **M2: Comments** | The social contract on testnet (all four types, rehearsed). The script that shows comments, and the write site under a testnet name: signing in, posting, deleting, and hiding by the owner. A Comments block | A comment posted from DashPay on one testnet site appears there, cannot be posted under a name the author does not own, and can be hidden by the owner. The shell has no widget code in it. Measured costs per comment and per site are in the docs |
| **M3: Polls** | Opening a poll from the builder, voting, proved tallies, closing. A Poll block | A second vote from the same identity is refused by Platform, and a vote after closing is refused |
| **M4: Mainnet** | The builder at `dash.site/new`, the write site under its mainnet name, the social contract on mainnet | After PR #14's contract is on mainnet and Pasta approves the registration, with its cost quoted from testnet |
| Later | Several pages and a blog list, a template gallery, web fonts, more widgets (guestbook, reactions, a "pay alice.dash" button), a Publii guide, posting inside the page | |

**M1 as built.** The reference page was built in the editor and published on
testnet (`page-demo-2511.dash`), then opened for editing in a second browser
that was not signed in. The builder's policy is unchanged, and the editor
makes no request to another host. Three things fall short of the row above:

- The reference page's text costs 0.00172 DASH; with its 96-pixel picture
  the estimate is 0.00242 DASH, over the 0.002 target.
- Phones were tested in Chromium's emulation with touch, not on a device,
  and Safari and Firefox were not tested.
- The editor is not in a sandboxed frame (§5.1).

Added since the row was written: the Auto look, and the panel that moves
large files off Platform.

M1 is deliberately the part with no permanent consequences: no contract, no
visitor keys, no new name, no change to the shell. It answers whether people can build a site
they like without writing code.

## 8. Decisions wanted

1. ~~Blocks (Puck) or free-form (GrapesJS)?~~ Decided and built: blocks,
   with upload as the free-form path.
2. ~~Go for M1 on the testnet builder?~~ Decided and built (§7).
3. **Should the social contract have moderators** who can delete any comment,
   or none, as `dash-sites` has? It cannot be added after registration.
   Recommended: none; owners hide.
4. ~~Add a manifest version to the shell~~ Decided and built: in manifest
   version 3 an entry may list where a file is kept (§5.4).
5. **The widget name, and the identity that owns it.** A name of fewer than
   20 characters with no digit from 2 to 9, such as `widgets`, goes to a
   masternode vote; a longer one, or one with such a digit, registers at
   once.
6. **May builder-made sites load fonts from npm mirrors** as well?
   Recommended: not yet.
7. **Move the editor into a sandboxed frame before the builder with the
   editor goes to `dash.site/new`?** Recommended: yes (§5.1).

## 9. Not in this proposal

Free-form layout in our own editor, a server of any kind, comments on
websites that are not Dash Sites, private or paid content, token-gated
pages, weighting votes by masternode or balance, and anything on mainnet
before M4.
