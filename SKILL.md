---
name: image-change-qa-board
description: Create, revise, and review e-commerce imagery for Amazon, Shopify, marketplaces, storefronts, product pages, merchandising, and ads. Track product-image truth, channel context, revision rounds, references, feedback, and approvals in a fast local review app, and verify product identity against registered truth photos side by side. Also use when the user asks for the image-change QA board, product-identity checks, or visual revision tracking.
---

# Commerce Image QA

Treat Codex as the creation and revision surface and the local review app as the decision surface. Keep image history and review state project-local, deterministic, and separate from chat history.

Use this skill automatically for e-commerce image generation, restoration, retouching, upscaling, background or lifestyle work, layout/crop adaptation, comparison, and revision—even when the user does not explicitly ask for a QA board. Do not build a board during brainstorming; record work when the first reviewable output exists.

## Product and channel truth

Before generation or revision, identify what is known about:

- SKU or stable product identifier;
- exact product shape, variant, color, finish, packaging, quantity, and included items;
- label copy, logos, claims, dimensions, and details that must not change;
- destination channel, market, and image slot;
- requested change, reference examples, and prior approved version.

Register what is known once per SKU (see below) so every later image inherits the same invariants and truth photos. Never silently invent missing product facts. Preserve the actual source product in channel-constrained imagery. In particular, treat an Amazon main image as photo enhancement/retouching of the actual product, not a speculative product mockup. Verify current official channel requirements before claiming an asset is publish-ready; category rules may override general rules.

Separate mechanical preflight from visual judgment. Dimensions, file type, file size, and measurable background/framing checks may be automated. SKU identity, label fidelity, included items, claims, unrequested changes, and reference alignment require explicit visual QA. A machine pass is not user approval.

## Register product truth once per SKU

Product identity is a property of the SKU, not of one image. Register it once per project and every later `add` for that SKU or product name inherits it, from any chat:

```bash
"<skill-dir>/scripts/commerce-qa" truth \
  --project "<project-root>" \
  --sku "<SKU>" \
  --identity "truth/front-label.png" \
  --identity-label "Front label" \
  --identity-caption "Wordmark and flavour text must match exactly" \
  --identity "truth/packaging.png" \
  --identity-label "Packaging" \
  --product-truth "Wordmark is one word, no substituted characters" \
  --product-truth "Variant is Mint Original, 500 g"
```

An `--identity` image is a source-of-truth product photo the result must stay faithful to: the supplier shot, a label close-up, the packaging, the last approved rendering. It must be a project-relative local file so it can be fingerprinted; a stylistic target belongs in `--reference` instead. `--product-truth` records the invariants in words. Repeat either flag for each entry.

The registry lives in `<project>/.image-change-qa/truth.json`, keyed by SKU (product name is accepted as a fallback key). Re-registering a path updates it in place and keeps its slot position. `--clear` replaces a product's registered truth with whatever the same call supplies, and `--list` prints what is registered. Registered truth is part of each item's review criteria, so replacing a truth photo or an invariant invalidates decisions taken against the old one instead of silently keeping them.

Record image-specific anchors on the item itself with the same flags on `add` when one image needs an anchor the SKU does not:

```bash
--identity "rounds/r1-approved.png" \
--identity-label "Approved R1" \
--identity-caption "Last approved rendering"
```

## Fast path: record and open

Use one command after each reviewable generation. It records the output, starts or reuses the shared Commerce QA service, registers the project board, and opens the board only when needed. Later outputs refresh an already-open board automatically.

```bash
"<skill-dir>/scripts/commerce-qa" add \
  --project "<project-root>" \
  --board "<short project or client name>" \
  --product "<product name>" \
  --sku "<SKU>" \
  --channel "Amazon" \
  --market "US" \
  --asset-slot "Main image" \
  --product-truth "Variant is dark roast, 500 g" \
  --product-truth "Front label text and forest-green pack must remain exact" \
  --title "Image 1" \
  --round "R2" \
  --before "<project-relative prior image>" \
  --after "<project-relative result>" \
  --client-feedback "<exact client wording>" \
  --internal-feedback "<exact user/team wording>" \
  --finding "<concise evidence-based QA result>" \
  --status "Ready"
```

Omit `--board` after the first call; durable board identity is stored in `<project>/.image-change-qa/board.json`. Do not pass `--before` for an ordinary revision: an asset slot is a lane, and the recorder links each new version to the newest existing version of the same product and slot by itself. Pass `--before` only to compare against a deliberately chosen earlier version, and `--no-before` only when the image is genuinely from scratch even though the slot has history. Keep `--asset-slot` stable across rounds (`MAIN`, `PT01` … `PT08`); it is what identifies the lane. Omit `--product-truth` and `--identity` once the SKU is registered; both are inherited. Omit unused feedback-source flags. Repeat `--product-truth` for every known invariant and repeat a feedback flag for multiple notes. `--request` plus optional `--source` remains supported for compatibility. Use `--no-open` only when the user asks to keep generating without review.

For visual examples, save important references in the project and repeat:

```bash
--reference "<project-relative reference>" \
--reference-label "Client example" \
--reference-caption "Match the layout and hierarchy"
```

The stable revision identity uses product + title + round unless `--id` is supplied. A matching identity replaces an in-progress entry; use a new round label to preserve approved history. Manifest updates are locked and atomic so parallel chats can add different assets safely. The recorder fingerprints local images and review criteria so decisions cannot be applied to changed files or changed requirements unnoticed.

## Open the review sidecar

The normal review surface is one shared loopback-only browser app. To reopen the current project board without adding an image:

```bash
"<skill-dir>/scripts/commerce-qa" open --project "<project-root>"
```

The service binds only to `127.0.0.1`, starts on demand, and is reused by every chat. One service can host several isolated project boards simultaneously; each project keeps its own tokenized route, manifest, review state, and submissions. Open one board at a time and let the user ask for the next one. Every board shares a single origin, a browser allows only six connections to it, and a board that is being looked at holds one for live updates; opening many boards at once leaves nothing for the images and every board renders blank. Report the remaining board URLs instead of opening them. Use `--round "<label>"`, `--filter-source Client`, or `--all-rounds` only when requested. `commerce-qa list` shows registered boards and `commerce-qa status` reports service health. Do not start a separate server per chat.

The service stamps the skill files it loaded. Editing the skill retires the running service on the next command automatically, so never ask the user to restart it by hand. A loaded project is cached and revalidated by file stats, so a board with many images stays responsive; touching any image, the manifest, or the truth registry still forces a full reload and re-fingerprint. A decision that can no longer be honoured is reported to the reviewer as reset rather than dropped in silence. An image that has been moved or archived since it was recorded costs the board that one item, reported to the reviewer, never the whole review.

Keep the default interface dark, nearly empty, and focused on the image: one full-viewport review canvas, one compact decision dock, and no main-page scrolling. Hide requests, technical checks, references, queue, and comparison controls behind contextual controls. Do not expose implementation status, audit data, file names, or full checklists during ordinary review.

The result is always the right side of the canvas. The left side is a stack of optional slots — the prior round first, then every product-truth anchor — and every comparison mode works against whichever slot is active, so a truth photo can be split, swiped, held-to-peek, or difference-blended exactly like a before image. Open genuine revisions in Split against Before. Open created-from-scratch work in Split against its first truth anchor, or on the result alone when no anchor is registered. Compare exposes two rows: which slot the result is judged against, and how. Number keys pick a slot, `s` cycles, held space peeks the active slot, and `t` hides the invariants. The strip in the canvas explains whatever is being compared against: on the prior version it shows the requested change in the client's own words, and on a truth anchor it shows what that anchor is authoritative for followed by the invariants, so identity is judged against words and pixels at once.

Identity also drifts over time. Each round changes a little, so no single before-and-after looks wrong while the product creeps away from its truth. `H` lays every version of the image under review on one sheet in order, each labelled with its round, its date and the feedback that produced it, beside the active anchor. Picking any version compares the current result directly against it, which is how cumulative drift is caught and how a baseline is chosen before recording an explicit `--before`.

Identity is also a cross-image question — one image disagreeing with the rest of a product's gallery is invisible when images are reviewed one at a time. `G` lays every image of the product on one sheet beside the active anchor, drawn from every round so it shows the newest version of each slot rather than only the round under review. Switching anchors re-frames the whole sheet; a tile opens that image with the anchor kept. Tiles are cached thumbnails built on first use, never while recording. A truth anchor in the details drawer is one click from becoming the active comparison.

The app opens on the first undecided asset. Approve auto-advances. Change opens one compact feedback composer; a plain note is the fast path and pinned notes are optional. Result-only, before, swipe, and difference comparison remain available on demand for revisions. Enable Send to Codex as soon as one asset has a valid decision. A partial handoff includes reviewed assets only and leaves every undecided asset explicitly untouched; the user may continue reviewing and send again later.

## Apply submitted feedback

Read the latest unapplied handoff before editing:

```bash
"<skill-dir>/scripts/commerce-qa" read --project "<project-root>"
```

Require `contract: "passed"` and no stale reviewed items. Capture `submissionId`. Inspect `scope`: for a partial handoff, apply only submitted Needs work items, preserve submitted approvals, and leave every item listed under `undecided` untouched. Apply reviewed Needs work items together where practical. Preserve every approved asset, reference constraint, product-truth requirement, and unmentioned element. Annotation coordinates are normalized to the reviewed image viewport; use their text and numbered order as the authoritative instruction. An annotation may carry `against`, naming the slot the reviewer was comparing to when the pin was placed; treat that slot as the authority for what the element should look like.

Each handoff pins the exact item IDs visible when it was sent. A newer round added by another chat may refresh the live board, but it cannot silently change an existing submission's scope.

Create a new revision round for resulting assets, retain the actual reviewed version as `before`, rerun full-resolution QA, and record the new outputs through `commerce-qa add`. After the requested work is safely recorded, mark that exact handoff applied so another chat cannot repeat it:

```bash
"<skill-dir>/scripts/commerce-qa" applied \
  --project "<project-root>" \
  --submission "<submissionId>"
```

## Inline fallback

Use the compact inline board only when the user explicitly prefers review inside Codex, the review contains at most a few images, or a local server cannot be kept running:

```bash
NODE_PATH="<bundled-node-modules>" "<bundled-node>" \
  "<skill-dir>/scripts/build-qa-board.mjs" \
  --project "<project-root>" \
  --latest-round \
  --output "<thread-visualization-dir>/image-change-qa.html"
```

Require `contract: "passed"`, an empty `staleItems` array, and output below 2 MB. Present it with `::codex-inline-vis{file="image-change-qa.html"}`.

## Review invariants

- Preserve exact feedback wording and distinguish Client, Internal, and Codex sources.
- Let the recorder resolve `before`. Its reply reports `beforeSource` (`derived`, `explicit` or `none`) and the `parentId` it linked; check that rather than assuming.
- Never infer pairs from filenames. An explicit `--before` that is not the slot's newest version is recorded as a chosen baseline and shown as one, not as lineage.
- Register SKU truth before recording the first image of a product, so identity is reviewable from round one.
- Treat `--identity` as fact and `--reference` as taste. Never register a generated or speculative rendering as product truth.
- Re-register a truth photo only when the real product changed; replacing one deliberately invalidates decisions made against the old truth.
- Treat one output created from several notes as one revision with several feedback entries.
- Keep approved older rounds in the manifest but review the latest round by default.
- Omit `before` for created-from-scratch work instead of fabricating comparison history.
- Keep important visual references local so they remain inspectable and fingerprinted.
- Never publish, upload, or replace live Amazon/Shopify assets unless the user separately authorizes that action.
- Preserve approved and unmentioned assets; do not turn them into change candidates.
- Reuse the durable board discovered from the project root. Never merge unrelated projects merely because they were opened from the same chat.
- Treat a submission ID as a single handoff. Do not apply an already-applied submission again unless the user explicitly requests it.

After changing the review template, server, or data contract, test a realistic multi-image project in a browser. Verify that ordinary review fits without scrolling at desktop and mobile sizes, then verify refresh persistence, hidden comparison modes, slot switching by click and keyboard, inherited and item-level truth anchors, the invariant strip, optional pins with their comparison context, keyboard decisions, contextual preflight, partial and complete submission, and stale-version rejection after a changed image or changed registered truth.
