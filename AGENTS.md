# AGENTS.md

## Project

Linux.do Keyword Blocker — a single-file Tampermonkey userscript (`ld-blocker.user.js`) that hides or dims posts on https://linux.do by keyword. No build system, package manager, tests, or lint config exist; the file is loaded directly into Tampermonkey.

## Structure

- `ld-blocker.user.js` — the entire script (storage, matching, styles, panel UI, MutationObserver). All edits happen here.
- `README.md` — Chinese user-facing docs (install, usage, panel buttons). Update it when panel buttons/behavior change.
- `.trae/` and `.claude/`, `.cursor/` are gitignored — do not commit or touch them.

## Userscript constraints

- The `==UserScript==` header must stay valid: `@match https://linux.do/*`, `@grant GM.getValue/GM.setValue/GM.registerMenuCommand`, `@run-at document-idle`, plus `@downloadURL`/`@updateURL` pointing at the raw GitHub file.
- Bump `@version` on every behavioral change (this is how Tampermonkey delivers updates) and keep it in sync with the version noted in commits.
- Code runs as an IIFE in `'use strict'` inside the page context of a Discourse forum — no imports, no external dependencies, plain DOM APIs only.

## Architecture / conventions

- Settings persist under a single `STORAGE_KEY` via GM storage as JSON. Shape changes must stay backward-compatible: `loadSettings` merges over `DEFAULT_SETTINGS`, and `keywords` are re-normalized (trimmed, deduped) on load. Call `refreshKeywordCache()` whenever settings change — it rebuilds the lowercased keyword list and bumps `kwVersion`, which invalidates the match cache (`matchCache`/`nodeMatchCache`).
- Topic filtering works by toggling the `data-lkcb-state="hidden|dimmed"` attribute on Discourse DOM nodes, always through `applyTopicState` (idempotent, skips nodes already in the right state). Do NOT switch back to classes: Ember asynchronously rewrites row `class` (category/tag/heat classes) when data loads late, which wipes injected classes and makes blocked topics flash back; `data-*` attributes survive.
- Performance model (v1.3+): full `scanTopics()` runs only at init and on settings changes; the MutationObserver (childList + subtree only — do NOT re-add `attributes: true`, it makes the script's own writes retrigger itself) processes newly inserted rows synchronously via `handleAddedNodes`, which runs before the browser paints and prevents the "appear-then-vanish" layout jump. Content-filled skeleton rows need a forced recompute (`findMatchedKeyword(topic, true)`) or the empty-text "no match" result stays cached; Ember also recycles DOM nodes, so stale `data-lkcb-*` attributes must be cleared from re-added nodes even when blocking is disabled. Match results are cached per `topicId` and invalidated via `kwVersion`. `TOPIC_SELECTORS` overlap, so skip elements whose ancestor also matches (`closest(TOPIC_SELECTORS)`).
- UI text is Simplified Chinese, matching README and the linux.do audience. Keep new user-facing strings in Chinese.
- The trigger button position is user-draggable and persisted (`triggerPosition`); `positionTriggerDefault()` anchors relative to the site's `.language-switcher-trigger` — a linux.do-specific selector that may break if the site redesigns (same risk applies to `TOPIC_SELECTORS`/`TITLE_SELECTORS`, which mirror Discourse markup).

## Testing

No automated tests. Verify manually: install the script in Tampermonkey, browse linux.do, add keywords via the 「屏蔽词」 panel, and confirm hide/dim modes, persistence across reloads, dragging, and export. Discourse renders new topics dynamically, so also check filtering on infinite-scroll and after navigation (SPA route changes retrigger the observer, not a full page load).
