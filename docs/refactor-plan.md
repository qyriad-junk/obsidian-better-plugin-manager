# Refactor plan

Proposed 2026-10-05, after the trivial-bug pass (`fix/trivial-bugs`). Ordered so each step makes the next ones,
and the known annoyances, smaller. Background and line-level detail: [codebase-notes.md](codebase-notes.md).

## Decisions so far (Qyriad, 2026-10-05)

- BPM's own per-plugin record is the source of truth for "wanted on", in both modes. (Step 1 as proposed.)
- Startup should be framed as **"blocks workspace-ready" vs. "doesn't"**, not seconds: delays were only ever a way to
  get plugins out of the blocking set. Step 2 is reframed accordingly (startup tiers; any remaining delay counts from
  layout-ready). Within the "after ready" tier, plugins start in list order; no separate ordering control (2026-10-07).
- Native toggles (Obsidian's own settings, CLI) are adopted as the user's intent instead of being "taken over":
  BPM never calls `*AndSave`, so any `enabledPlugins` change it didn't make is the user's. The takeover prompt and its
  settings go away (2026-10-07).
- Remove upstream branding (step 3).
- The manager becomes a workspace tab, and **never auto-opens at startup** (step 7).
- Runtime verification is possible now: `scripts/sandbox/` runs a real Obsidian headlessly.

The guiding problem: **the code has no single owner for "is this plugin on, and how does it get started"**.
Six places answer that question differently, and every annoyance and most remaining bugs sit on top of that.

---

## 0. Groundwork: a test harness and a current toolchain

Nothing can run Obsidian in CI or in the cloud container, so pure-logic tests against a fake
`app.plugins` registry are the only safety net for everything below. This pass already used two throwaway versions
(troubleshoot simulation: old code failed 3666/5814 runs; version-comparator table).

- Add **vitest** (handles TS and aliasing `obsidian` to a stub directly) with a small fake `PluginManager` that
  mirrors the verified 1.13.7 semantics (persisted `enabledPlugins` vs. loaded `plugins`, `enablePlugin` returning
  `false` without a manifest, debounced `saveConfig`). Move the two scratch harnesses in as the first tests.
- Bump TypeScript 4.7 → 5.x and pin `obsidian` types to a current release instead of `"latest"` resolving to 1.4.11.
- Add a `lint` script with the store bot's `eslint-plugin-obsidianmd` ruleset. 198 findings today; treat it as a ratchet.

## 1. One owner for plugin enablement (the untangle)

A new module (working name `PluginStartup`) that is the only code allowed to call
`enablePlugin` / `disablePlugin` / `*AndSave` or touch `enabledPlugins`. It distinguishes three things that are
currently blurred, and names them distinctly so the difference survives in hovers and call sites:

| Concept | Meaning | Lives in |
|---|---|---|
| **wanted** | the user wants this plugin running in this vault | `ManagerPlugin.enabled`: *the* source of truth for every non-ignored plugin, in both modes |
| **native startup list** | what Obsidian itself loads at launch | `app.plugins.enabledPlugins` (+ `saveConfig()`) |
| **loaded** | running right now | `app.plugins.plugins[id]` |

- Delay mode stops being a second *model* and becomes a **policy** for the native list. Delay mode puts BPM + ignored
  plugins in it (BPM starts the rest); normal mode puts every wanted plugin in it. Switching modes rewrites the native
  list in memory and calls `saveConfig()`, with **no plugin reloads** (today every plugin is unloaded and reloaded, twice over).
- `bpm-ignore` keeps its meaning: the native list is authoritative for that plugin and BPM never writes its intent.
- API sketch: `isWanted(id)`, `isLoaded(id)`, `setWanted(id, on)` / `setWantedMany(map)`, `startOnce(id)`
  (today's "single start"), `restart(id)`, `afterInstallOrUpdate(id, { wasWanted })`.
- Every caller moves onto it: `command.ts`, the modal's card toggle and bulk toggle, troubleshoot, transfer import,
  GitHub install/update, source auto-update, self-check.

**Fixes for free:** updates no longer force-enable plugins (*annoyance 5*); fresh installs actually load;
install/import respect delay mode; the takeover dance mostly disappears (the native list is always derived, so there's
nothing to "take over"); the six disagreeing `isEnabled` checks collapse into one.

## 2. Delay scheduler

Pulled out of `main.ts` and owned by step 1's module.

- **Measure delays from layout-ready, not from BPM's `onload`.** Verified 1.13.7 startup order: community plugins
  initialize *before* vault load, metadata-cache init and layout load. So today a 0.5 s delay fires in the middle of
  startup, competing with indexing and layout. Anchoring to `onLayoutReady` makes the number mean "seconds after I
  can type". (Caveat: a plugin whose *view* is restored in the saved layout still wants to be native/ignored. That's
  true today too.)
- Load delayed plugins **one at a time with a yield between them**, instead of firing every same-delay timer at once.
- Delays become **fractional seconds** in the UI (number input, not an integer 0–100 slider) (*annoyance 6*).
- After each batch, **re-apply the saved ribbon layout** (step 6), which fixes delay-loaded plugins' hidden ribbon items reappearing.
- In debug mode, log when each plugin was started and how long its `onload` took, so delays can be tuned with data.

## 3. Delete dead code and upstream branding

This shrinks the surface before the UI work: `vault-share.ts` + the `vaults` page, `SystemRibbonManager`, `DisableModal`,
`developerMode` buttons, `getActivePlugins`/`processPlugins`, the `savePluginAndExport` alias, the never-produced
transfer file-bundle *export* path (import of bundles stays). Branding: the `bpm-eondr-plugin` auto-tag rules, QQ group
link, Afdian/bilibili links. *(Question below.)*

## 4. Plugin actions as data

One table of actions, `{ id, icon, label, isAvailable(ctx), run(ctx) }`, rendered by three thin adapters: card buttons,
context menu (desktop and mobile share one), command palette. That replaces the three hand-written copies in
`showData` and `PluginActionModal`. The "on card vs. in menu" placement setting maps onto it directly.

New actions fall out cheaply: **enable/disable** and a **"Delay ▸" submenu** in the right-click menu (*annoyance 4*).

## 5. One plugin card, no destructive edit mode

Today normal mode and edit mode render *different* cards, and entering edit mode re-renders the whole page
(`renderContent()` → `pageEl.empty()`), which loses scroll.

- One card component that always has the toggle and an inline delay control (*annoyances 2 and 3*).
- Edit mode only reveals the rename/description/layout fields: a CSS class plus per-card refresh through the existing
  `PluginCardController`s, never a full re-render.

## 6. Ribbon manager on native ids

Replace aria-label matching and CSS `order`/`display` overrides with Obsidian's own ribbon state, keyed by item id:
snapshot `workspace.json` `left-ribbon.hiddenItems` at startup, and after delayed plugins register, call
`leftRibbon.load({ hiddenItems: merged })`. `merged` is the live `serialize()` for registered items plus the snapshot
for not-yet-registered ones, so in-session changes aren't reverted. Root cause this addresses (verified):
`leftRibbon.load` only applies hidden/order to items that already exist, so a late plugin's item is appended visible
and the next layout save overwrites its hidden flag.

## 7. Split `manager-modal.ts` into pages, then re-host

Each page becomes a module behind a small interface (`render(container)`, `refresh()`, `dispose()`), and the 8k-line
class becomes a shell. Then host the shell in an **`ItemView`** (a normal workspace tab: persistent, keeps scroll,
can sit in a sidebar) instead of a `Modal` (*annoyance 1*). The modal can remain as a thin launcher if wanted. Pages
you don't use stay working but untouched.

## Smaller, whenever convenient

- `Translator.t`: drop the `(str: string)` overload so mistyped keys are compile errors.
- `loadSettings`: deep-merge defaults (no shared default arrays) and normalise once, instead of defensively at use sites.
- Merge the near-identical group/tag/delay settings pages into one taxonomy component.
- Protocol install: show a confirmation before installing/enabling from an `obsidian://` link, then wire the `github` param.
- Agreement + RepoResolver: one community-list fetch with a cache and TTL, not an unconditional download at every startup.
