# BPM codebase notes

Working notes on the fork of [eondrcode/obsidian-manager](https://github.com/eondrcode/obsidian-manager)
("Better Plugins Manager", plugin id `better-plugins-manager`).
Written 2026-10-05 after a full read of the source, so that nobody has to re-derive any of this.
Upstream's own guides (`AGENTS.md`, `.spec/**/spec.md`) are in Chinese and are accurate *maps*,
but they describe intent; several of their guarantees are contradicted by the code (see [Known issues](#known-issues)).

Claims about Obsidian's internals below were checked against Obsidian **1.13.7**'s `app.js`
(see [Verifying Obsidian internals](#verifying-obsidian-internals)), not recalled from memory.

See also [refactor-plan.md](refactor-plan.md) for the proposed untangling order.

---

## Build, tooling, state of the repo

| | |
|---|---|
| Install / build | `npm ci && npm run build` (= `tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`) → `main.js` (~1.5 MB, gitignored). `npm run dev` = esbuild watch. |
| Toolchain | TypeScript 5.9, esbuild 0.28, `obsidian` types ~1.13.1, `@types/node` 22, vitest 5 (Node ≥ 22.12 needed for tests). Was TS 4.7 / esbuild 0.17 / types silently 1.4.11 until 2026-10-07. `manifest.json` `minAppVersion` is still 1.5.8. |
| tsconfig | `noImplicitAny` + `strictNullChecks`, **not** full `strict`. `paths` maps `main` → `src/main` and `src/*`, so imports appear as `"main"`, `"src/…"` and relative paths interchangeably. |
| Entry | Root `main.ts` is a one-line re-export of `src/main.ts` (esbuild entry is the root file). |
| Tests | `npm test` (vitest). `tests/support/fake-plugin-manager.ts` models Obsidian's `app.plugins` with the verified 1.13.7 semantics, incl. simulated relaunches (`startup()`) and files appearing before `loadManifests()`; `tests/support/obsidian-stub.ts` stands in for the `obsidian` module at runtime. Test hosts should mirror production (e.g. `saveSettings()` reconciles); a test host that didn't once hid a real bug. Fake timers: use a 1 ms advance to flush, `advanceTimersByTimeAsync(0)` doesn't fire 0 ms timers scheduled during itself. |
| Lint | `npm run lint`: flat config with the community review bot's ruleset (`eslint-plugin-obsidianmd` recommended + the overrides from the sample-plugin-plus reference). Not in CI yet: 219 findings at introduction, 195 after step 1. New code should lint clean (e.g. `window.setTimeout`, not `setTimeout`). |
| CI | `ci.yml`: typecheck, test, build on every push. `release.yml`: on tag push, build and create a **draft** GitHub release with `main.js manifest.json styles.css`. |
| Release | `npm version <x>` runs `version-bump.mjs`, which syncs `manifest.json`, `versions.json`, `package-lock.json`. `.npmrc` sets `tag-version-prefix=""`. |
| Other tooling | `spexcode.json` + `.spec/` are artifacts of upstream's "SpexCode" spec-graph tool (business-domain spec nodes, each linked to source files). `.agent/references/obsidian-sample-plugin-plus` is a git submodule of general Obsidian plugin-dev guidance (run `git submodule update --init`). |
| Upstream sync | As of 2026-10-05 the fork's `main` == upstream `main` (`e56155f`). Upstream also has an unmerged `feat/i18n-integration` branch. `git ls-remote https://github.com/eondrcode/obsidian-manager` works from the cloud container. |

**A real Obsidian can be run headlessly** in the container (or any Linux box): see
[`scripts/sandbox/README.md`](../scripts/sandbox/README.md). It downloads the Linux build, runs it under Xvfb with an
isolated config and test vault, and drives it over CDP (`eval`, `screenshot`, `reload`, fake-plugin generator).
Behavioral claims marked *(runtime-unverified)* predate it. GitHub install/update flows still can't be exercised there
(`api.github.com` is out of reach), and mobile code paths never run.

---

## Repo map

Lines of code in parentheses. Real logic is ~13k lines; the rest is CSS (14k) and locales (~6k).

```
main.ts                         re-export of src/main.ts
src/main.ts                (1660) Manager extends Plugin. Lifecycle, settings load/save, delay-start engine,
                                  update checks, beta-source maintenance, ribbon styling runtime, GitHub token
                                  (SecretStorage), tag colour utils, version compare. Grab-bag.
src/settings/data.ts        (332) ManagerSettings (the whole data.json schema) + DEFAULT_SETTINGS + small types.
src/data/types.ts            (94) ManagerPlugin, Tag/Type(=group), Delay, RibbonItem, BetaSource, … + special tag ids.
src/data/data.ts             (19) unused-ish style label maps.
src/obsidian-internals.ts    (89) Hand-written typings for undocumented app.plugins / app.setting / leftRibbon.
src/command.ts              (704) Command palette: static + dynamic (per plugin/group/tag/profile) commands,
                                  plugin-control SuggestModals, profiles, "restore previous state" snapshot.
src/migrations.ts           (262) Versioned data migrations (0.3.1, 0.3.2), MIGRATION_VERSION bookkeeping.
src/plugin-startup.ts       (~480) PluginStartup: THE owner of which plugins run and how they start (see Core model).
src/version.ts               (75) Semver-aware compareVersions (the only version comparator).
src/path-safety.ts           (14) getSafePathSegment for plugin ids / theme names used as folder names.
src/repo-resolver.ts        (258) plugin id → GitHub repo (REPO_MAP → on-disk cache → official community list).
src/agreement.ts            (167) obsidian://BPM-plugin-install / BPM-plugin-github protocol handlers (legacy code).
src/github-url.ts            (47) Optional GitHub proxy URL rewriting ({url} / {encodedUrl} templates or prefix).
src/github-install.ts       (594) GitHub release listing (+5 min cache), plugin & theme install from releases.
src/source-release.ts       (240) Pure-ish logic: pick target release for a BetaSource, decide "has update".
src/import-export.ts       (1330) Transfer Pack (JSON, schema better-plugins-manager.transfer/v1): build/parse/preview/apply.
src/note-tip.ts             (204) Hover tooltip on the BPM ribbon icon listing plugin notes; right-click config panel.
src/vault-share.ts          (145) STUB. Every function returns "unavailable in the community-store build".
src/utils.ts                 (89) confirmWithModal, managerOpen (electron shell.openPath).
src/electron.d.ts             (5) declare module "electron" { shell.openPath }.
src/manager/system-ribbon-manager.ts (104) VESTIGIAL. Constructed but load/save/startWatch never called.
src/modal/manager-modal.ts (7977) THE UI. One Modal class with 8 "pages" + AppearanceProfileModal. God object.
src/modal/*.ts             (~2.3k) Auxiliary modals: group/tags/note/hide/delete/update/update-check/ribbon/
                                  bulk-status-confirm. disable-modal.ts is unused.
src/settings/index.ts + ui/ (~900) PluginSettingTab with tabs: basis, main-page actions, style, groups, tags, delay.
src/troubleshoot/         (~1.9k) Conflict bisection: algorithm, persisted state, TWO front-ends (floating
                                  TroubleshootModal + embedded TroubleshootPanel), result modal + Markdown report.
src/lang/inxdex.ts          (100) Translator (sic, "inxdex"). Locales in src/lang/locale/*.ts.
styles.css               (13956) All styling; mostly `.manager-*` BEM-ish classes, 363 `!important`.
tests/                            vitest suites + fakes (see Build table).
scripts/sandbox/                  Headless real-Obsidian sandbox (see its README).
```
(Line counts are from the 2026-10-05 read; self-check.ts has since been deleted.)

---

## Core model

### `data.json` (`ManagerSettings`, `src/settings/data.ts`)
Everything BPM knows lives in one object, loaded with a **shallow** `Object.assign({}, DEFAULT_SETTINGS, await loadData())`
(so default arrays/objects are shared references when the key is absent from disk). Notable fields:

- `Plugins: ManagerPlugin[]`: BPM's per-plugin record `{id, name, desc, group, tags[], enabled, delay, note}`.
  `name`/`desc` are *user-overridable* display values (seeded from the manifest). `group` is a single group id; `tags` many tag ids;
  `delay` a `DELAYS[].id`.
- `GROUPS` (type `Type`), `TAGS`, `DELAYS`: taxonomy lists referenced by id.
- `HIDES`: plugin ids hidden from the manager list (display only).
- `PLUGIN_LAYOUT`: manual ordering + named separators for the plugin list.
- `REPO_MAP`: confirmed `pluginId → owner/repo`. `BPM_INSTALLED`: ids installed via BPM.
- `BETA_SOURCES`: tracked GitHub sources (`BetaSource`): `mode: latest|frozen`, `updateCheckMode: release|version`,
  `compatibilityMode`, `updateDelayDays`, `autoUpdate`, plus a lot of cached release metadata.
- `RIBBON_SETTINGS`: `{id, name, icon, visible, order}` per ribbon item.
- `COMMAND_PROFILES` / `COMMAND_LAST_STATE`: saved enable-state maps; one undo snapshot.
- `APPEARANCE_PROFILES`: theme + CSS-snippet combos ("外观方案").
- `TROUBLESHOOT_STATE`: persisted bisection session (survives restarts).
- `GITHUB_TOKEN`: legacy plaintext token; migrated into `app.secretStorage` (`"github-token"`) when that API exists.
- `SHARED_VAULT_*`, `EXPORT_DIR`: dead/legacy.

An extra cache file is written to `<configDir>/better-plugins-manager-community-plugins-cache.json` (repo map snapshot).

### Special tags (ids are stable, names localised)
- `bpm-install`: auto-added to plugins in `BPM_INSTALLED`.
- `bpm-ignore`: "Obsidian's native startup list is authoritative for this plugin". BPM never schedules it, and the
  manager, commands and bulk actions won't toggle it (conflict diagnosis can). Adding/removing the tag anywhere is
  picked up by `PluginStartup.reconcile()` on the next settings save.
- `bpm-eondr-plugin`: upstream author's self-branding. Auto-applied to plugin id `i18n` or any repo owned by `eondrcode`
  (`EONDR_PLUGIN_RULES` in `src/main.ts`).

### Plugin enablement: one owner, `PluginStartup` (the most important concept)
Since 2026-10-07 (`refactor/plugin-startup`), `src/plugin-startup.ts` is the only code that loads/unloads plugins or
touches `app.plugins.enabledPlugins` (except the dead developer-mode buttons reloading BPM itself). It keeps apart:

| Concept | Meaning | Lives in |
|---|---|---|
| **wanted** | the user wants it running | `ManagerPlugin.enabled`, the source of truth in both modes (for `bpm-ignore` plugins: the native list) |
| **native startup list** | what Obsidian loads at launch | `enabledPlugins` + `saveConfig()`; *derived*: BPM itself + ignored plugins as left + (normal mode) every wanted plugin |
| **loaded** | running now | `app.plugins.plugins[id]` |

- Delay mode is a *policy* for the native list, not a second model. `setDelayMode()` only rewrites the list (no reloads).
- **Native toggles are adopted, not "taken over".** BPM never calls `*AndSave` and notes every load/unload it causes, so
  on `app.plugins` "changed": added to the native list → wanted; removed from it, or unloaded without BPM → not wanted.
  At launch, `start()` does the same for the list Obsidian just used. Obsidian's own toggle shows *running* state, so
  switching off a BPM-started plugin there only unloads it; that's why unloads are tracked too.
- `Manager.saveSettings()` runs `reconcile()` first, so the native list is re-derived on every save.
- API used by callers: `isWanted/isLoaded/isManaged`, `setWanted(id, on, { userInitiated })`, `setWantedMany`,
  `startOnce` (run without wanting), `restart`, `whileUnloaded(id, fn)` (e.g. writing data.json), `setIgnored`,
  `applyInstalledFiles(id, { wantedIfNew })` (installs/updates: read manifest, keep on/off, reload if running).
- `userInitiated: true` mirrors Obsidian's own toggle (`onUserEnable()`; panes closed on disable). Delayed starts,
  troubleshooting and imports pass false.

### Delay-start mechanics
- **When the delay clock starts:** Obsidian's startup order is core plugins → community plugins (`plugins.initialize()`,
  each `enablePlugin` awaited in turn) → `vault.load()` → `metadataCache.initialize()` → `workspace.loadLayout()` →
  opening behavior → layout-ready (then `onLayoutReady` callbacks, one per `sleep(0)`). BPM schedules its timers in its
  own `onload`, i.e. during the community-plugin step, *before* the vault is even loaded, so short delays fire in the
  middle of startup. Fractional delays work (`setTimeout(time * 1000)`), but the settings slider is integer 0–100.
- Every launch with `DELAY=true`: Obsidian loads only BPM and ignored plugins; `PluginStartup.start()` schedules
  `window.setTimeout(load, delay.time * 1000)` for each wanted managed plugin (0 if no delay profile). Same-delay plugins
  fire together, not sequentially. (Step 2 of the refactor plan replaces this with startup tiers counted from layout-ready.)
- Switching delay mode, or BPM being unloaded while delay is on (`stop()`): only the native list changes; nothing is
  reloaded. `stop()` hands wanted plugins back to Obsidian and starts any still pending. Obsidian does **not** unload
  plugins on app quit (verified), so `stop()` only runs when BPM itself is disabled, reloaded or updated.

### Startup sequence (`Manager.onload`)
1. `loadSettings` → `runMigrations` → pick language on first run → `new Translator`.
2. Ensure built-in tags exist and normalise their names; ensure BPM's own record (always enabled, no delay, never hidden).
3. `new RepoResolver`; ribbon config sync or clear.
4. `addRibbonIcon` + `NoteTipFeature`; `addSettingTab`.
5. `synchronizePlugins` (reconcile `Plugins[]` with installed manifests), then `new PluginStartup(…).start()`: adopt the
   native list Obsidian launched with, re-derive it, and in delay mode schedule the timed starts.
6. `Commands(app, this)` registers commands; save if anything was dirty.
7. `new Agreement` (**fetches the full community-plugins.json on every startup**), fire-and-forget
   `startupCheckForUpdates` and `startupMaintainBetaSources` (check + auto-update tracked sources).
8. Register `obsidian://BPM-plugin-install` and `obsidian://BPM-plugin-github`.
9. `onLayoutReady`: start ribbon runtime (drag-to-hide on desktop; MutationObserver on mobile menus);
   after 2 s, clean `undefined` holes from `leftRibbon.items`. (The delay-mode self-check/takeover prompt is gone.)

---

## Obsidian internals relied on

All undocumented, typed loosely in `src/obsidian-internals.ts` or via `@ts-ignore`/casts.

| Internal | Used for | Verified semantics (1.13.7) |
|---|---|---|
| `app.plugins.manifests` | list installed plugins | populated by `loadManifests()`; **not** auto-refreshed when files appear on disk |
| `app.plugins.enabledPlugins: Set` | "enabled" in normal mode | the **persisted** startup set, mirror of `community-plugins.json`; *not* "currently loaded" |
| `app.plugins.plugins[id]` | detect loaded instance | the actually-loaded plugin objects |
| `enablePlugin(id, userEnable?)` | delay start, single start | returns `Promise<boolean>` (BPM types it `void`). Returns `false` if `manifests[id]` is missing, restricted mode, deprecated/blocklisted, or desktop-only on mobile. Doesn't touch `enabledPlugins`. Idempotent (`loadPlugin` returns the existing instance). |
| `disablePlugin(id)` | | unload only |
| `enablePluginAndSave` / `disablePluginAndSave` | normal-mode toggles | `enablePlugin(id,true)` then `enabledPlugins.add` + `requestSaveConfig()` (debounced 1 s) / `enabledPlugins.delete` + `requestSaveConfig()` + `disablePlugin(id,true)` |
| `saveConfig()` | (not used by BPM) | writes `Array.from(enabledPlugins)` to `community-plugins.json` |
| vault `raw` → `plugins.onRaw` | | **never re-reads `community-plugins.json`**; only calls `plugin.onConfigFileChange()` for `<id>/data.json` changes, and only if `enabledPlugins.has(id)` |
| `installPlugin(repo, version, manifest)`, `uninstallPlugin`, `loadManifests` | protocol install, delete | |
| `app.setting.open/openTabById/activeTab` | open plugin settings / hotkeys tab | |
| `app.commands.removeCommand`, `.commands` | dynamic command refresh | |
| `app.customCss.setTheme/theme/enabledSnippets` | themes & snippets pages | |
| `app.secretStorage.get/setSecret` | GitHub token | probed defensively |
| `app.i18n.locale`, `window.moment.locale()` | first-run language | |
| `workspace.leftRibbon.items` | ribbon manager | items are `{id, icon, title, callback, hidden, buttonEl}`; native order/hidden persist in `workspace.json` `left-ribbon.hiddenItems` (key order = order); `addRibbonItemButton` updates an existing id **in place**, otherwise appends `{hidden: false}`; `load(hiddenItems)` only applies hidden/order to items that **already exist** |

Consequences worth internalising:
- Writing `community-plugins.json` directly (as the old self-check takeover did) leaves Obsidian's in-memory `enabledPlugins` stale, so the
  next `*AndSave` from anywhere rewrites the file from memory and silently undoes the takeover. The correct move is to mutate
  `app.plugins.enabledPlugins` and call `saveConfig()`/`requestSaveConfig()`.
- Plugins started by BPM's delay mode are not in `enabledPlugins`, so they **never get `onConfigFileChange()`** (e.g. when
  Obsidian Sync updates their `data.json`). That's a real, undocumented cost of delay mode.
- Editing the startup list doesn't require reloading plugins at all (see the delay toggle above).
- **Why hidden ribbon icons of delay-loaded plugins come back** (any lazy loader, not just BPM): at layout load the
  plugin's ribbon item doesn't exist yet, so `leftRibbon.load()` skips its saved `hidden: true`; when the plugin later
  calls `addRibbonIcon`, a fresh visible item is appended at the end, and the next layout save persists it as visible.

### Verifying Obsidian internals
```sh
curl -sSL https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json   # latest version + asar URL
curl -sSLO https://github.com/obsidianmd/obsidian-releases/releases/download/v1.13.7/obsidian-1.13.7.asar.gz
gunzip obsidian-1.13.7.asar.gz && npx @electron/asar extract obsidian-1.13.7.asar app
# app/app.js is one 3.8 MB minified line: slice around a symbol with python, e.g.
python3 -c "s=open('app/app.js').read(); i=s.find('enablePluginAndSave='); print(s[i-2000:i+800])"
```

---

## Features, module by module

### Manager modal (`src/modal/manager-modal.ts`)
- Pages (`ManagerPage`): `plugins`, `themes` (appearance overview: profiles/themes/snippets), `install`, `sources`, `transfer`,
  `vaults` (disabled by `SHARED_VAULTS_ENABLED=false`, backed by the stub), `ribbon` (only if ribbon manager on), `troubleshoot`.
- `renderContent()` / `reloadShowData()` dispatch on `activePage`. A monotonically increasing `renderGeneration` lets async
  renders bail out if the user navigated away (`isRenderCurrent`).
- `showData()` (~1100 lines, ~3049–4145) builds the plugin list in batches of `renderBatchSize = 80`; each card registers a
  `PluginCardController` so single cards can be refreshed (`refreshPluginCard`) without a full re-render.
- Card actions are configurable to sit on the card or in the right-click menu (`MAIN_PAGE_ACTION_PLACEMENT`, settings page
  "主页面功能"). The action wiring is written out three times: desktop context menu (~3205), mobile menu (~3674), on-card buttons (~3818).
- Filters: status / group / tag / delay, each multi-select with `contains | not-contains`; optionally persisted
  (`PERSISTENCE`, `FILTER_*`). Search is debounced (120 ms render, 350 ms persist).
- Modes: `editorMode` (edit names/descs/layout, separators, drag reorder via custom pointer-drag), `bulkEditMode`
  (multi-select → group/tags/delay/enable/disable). `developerMode` is never set to true (dead buttons).
- House style shared by all modals: remove Obsidian's `.modal-close-button`, build a custom title bar from `Setting`.

### Install & update pipeline
- `fetchReleaseVersions` (`github-install.ts`): `/releases/latest` + paginated `/releases?per_page=100`; drafts dropped;
  with `includeManifest`, it fetches **each release's** `manifest.json` (asset, else raw at tag) to learn `minAppVersion`.
  Cached 5 min per (repo, token?, proxy, includeManifest).
- `installPluginFromGithub`: release assets `manifest.json`/`main.js`/`styles.css` in parallel; if incomplete, falls back to
  `raw.githubusercontent.com/<repo>/<tag or v-variant>/…`. Writes files → `BPM_INSTALLED`/`REPO_MAP` →
  `pluginStartup.applyInstalledFiles()` (new: on unless `wantedIfNew: false`; update: keeps on/off, reloads if running).
- `installThemeFromGithub`: assets `manifest.json` + `theme.css` (or `themes.css`/`theme-beta.css`), writes to
  `themes/<manifest.name>/`, then `customCss.setTheme`.
- Update check (`Manager.checkUpdates`): downloads `community-plugin-stats.json` (official plugins' version map), then for
  every plugin *sequentially* resolves its repo and fetches release versions (with manifests). `source-release.ts` decides the
  target: `frozen` → pinned tag; `latest` → GitHub's "latest" release if compatible + old enough
  (`updateDelayDays`), else first matching release. "Has update" is by **release order/date** (`release` mode) or by version
  number (`version` mode).
- Repo resolution priority: `REPO_MAP` → on-disk cache → official `community-plugins.json` (result written back to `REPO_MAP`).
- GitHub proxy (`GITHUB_PROXY`): disables token use entirely (the token is never sent through a proxy).

### Transfer Pack (`src/import-export.ts`)
JSON with `schema: "better-plugins-manager.transfer/v1"`. Export selects plugins / themes / plugin `data.json` configs /
taxonomy / layout+ribbon / sources / workspace prefs. Import has a preview step and per-category opt-ins.
Path safety on import is careful (`getSafePluginId`, `normalizePackageRelativePath`, prefix check).
The format supports base64 **file bundles** (offline plugin/theme install), but the current export never produces
them (`collectPluginFiles` is commented out, themes are collected with `includeFiles=false`). Import still accepts them.

### Conflict diagnosis (`src/troubleshoot/`)
Adaptive group testing driven by the user answering "problem still exists?":
1. Disable everything. If the problem persists → not a plugin issue.
2. `bisect-main`: test half C1; fail → recurse into C1; pass → test C2; fail → recurse into C2; both pass → cross-partition pair.
3. `cross-pair-bisect-b/a`: keep A fully on, bisect B to find b*; then keep b* on, bisect A to find a*.
4. `verify-single` / `verify-pair` at sizes 1 and 2.
State persists in `TROUBLESHOOT_STATE`. Two separate UIs drive the same algorithm and duplicate the feedback/undo/restore
logic: `TroubleshootModal` (floating, hand-built DOM, from the command palette) and `TroubleshootPanel` (manager page).
The report is a Markdown file created in the vault root.

### Ribbon manager
Pure CSS/DOM at runtime: matches `.side-dock-ribbon-action` elements to `RIBBON_SETTINGS` **by aria-label text**,
then sets `style.order` / `style.display`, remembering originals in `data-bpm-original-*` attributes so they can be restored.
On mobile, it reorders `.menu-item`s inside the ribbon menu via a body-wide MutationObserver. Desktop "drag an icon out
of the ribbon to hide it" uses capture-phase pointer listeners on `activeDocument`.

### Commands (`src/command.ts`)
Static: `manager-view`, `control-plugin`, `save-command-profile`, `restore-previous-command-state`, `troubleshoot-conflicts`.
Dynamic (opt-in): per-plugin toggle `manager-<id>`, per-group `manager-<gid>-enabled|disable`, per-tag
`manager-tag-<tid>-enabled|disable`, per-profile `manager-profile-<pid>-apply`. Dynamic commands are rebuilt by calling
`Commands(app, manager)` again (a WeakMap keeps one service per Manager). Their *names* embed the current state
("Enable X"/"Disable X"), so every toggle triggers a command refresh.

### i18n (`src/lang/`)
- **Keys are Chinese strings** (e.g. `"管理器_删除插件_描述"`), mostly `<area>_<thing>_<kind>`; newer keys are English snake_case
  (`command_*`). `zh_cn.ts` is the canonical key set.
- Fallback: selected locale → `en` → `zh_cn` → the raw key. Interpolation `{name}`; some older call sites use `.replace('{count}', …)` instead.
- `Translator.t` has an overload taking any `string`, so **typos in keys aren't caught by the compiler**.
- Coverage (2026-10-05): zh_cn 953 keys, en 953, es/fr/ja/ko/ru 777 each (the same 176 keys missing → English fallback).
  One key used in code is defined nowhere: `通用_确认_文本`. 144 keys are never referenced literally (some may be built dynamically).
- Adding a language: new file in `locale/`, register in `Translator.language`, `Translator.localeMap`, and the locale maps
  in both `Translator.normalizeLang` and `Manager.getAppLanguage` (duplicated).

---

## Known issues

Ranked roughly by user impact. [C] = confirmed by reading code (and Obsidian source where relevant).
[L] = very likely from code + Obsidian source, but *(runtime-unverified)*. [R] = reproduced in the sandbox.

### Fixed on `fix/trivial-bugs` (2026-10-05)
Confirm dialogs' raw-key title and "OK" label · NoteTip title always Chinese, panel not dismissable · Ctrl+F listener
leaked per manager open, `managerModal` never cleared · troubleshoot windows stacking and leaking document listeners ·
startup update-check notice stuck on throw · redundant settings re-renders · unsafe remote manifest ids/names used as
folders · protocol handler crash without `enable` · self-check takeover silently undone (now updates
`enabledPlugins` + `saveConfig()`) · troubleshoot undo (now full-state snapshots; verified by simulation) and 0–2-plugin
sessions · three non-semver version comparators (now `src/version.ts`).

### Fixed on `refactor/plugin-startup` (2026-10-07)
Fresh GitHub installs not loading [R] · installs/updates force-enabling plugins (incl. source auto-update) · install,
update and transfer import ignoring delay mode · import writing data.json under a running plugin · delay mode on/off
reloading every plugin · the takeover prompt (replaced by adopting native toggles; native *disable* of a BPM-started
plugin is adopted too [R]) · six disagreeing "is it enabled?" implementations · start once / restart unavailable in delay mode.

### Correctness (open)
5. [C] Delay timers start during community-plugin init, before vault/layout load (see *Delay-start mechanics*).
6. [C][R] Hidden ribbon icons of delay-loaded plugins reappear (native `leftRibbon.load` behaviour, see internals); BPM's
   own ribbon manager matches by aria-label text and doesn't address it. Reproduced with two fake plugins (one native,
   one BPM-delayed); re-applying the pre-startup `hiddenItems` snapshot via `leftRibbon.load()` after the delayed load
   was confirmed to hide the icon again and persist `hidden: true`.
7. [C] Entering edit mode re-renders the whole plugin page (`renderContent()` → `pageEl.empty()`), losing scroll; edit-mode
   cards have no enable toggle; the context menu has no enable/disable or delay actions.

### Security / trust (open)
- [C] `obsidian://BPM-plugin-install?id=<community id>&enable=true` installs **and enables** a plugin with no
  confirmation UI. (The parsed `github` param is intentionally still not passed through until there is one.)

### Performance
- [C] `Agreement`'s constructor downloads the full community plugin list on every startup (unconditional network);
  `RepoResolver` separately fetches and caches the same list.
- [C] Update checks are sequential per plugin and fetch a manifest for every release of every plugin.
- [C] All delayed plugins with the same delay are started at once (one timer each), not sequentially.

### Structure / smells
- `manager-modal.ts` is an 8k-line god object.
- `settings/ui/manager-group.ts`, `manager-tag.ts`, `manager-delay.ts` are near-copies.
- Dead code: `vault-share.ts` (stub) + all `vaults` page UI, `SystemRibbonManager`, `DisableModal`, `developerMode`
  buttons, `getActivePlugins/processPlugins` (with `console.log`, and an `obsidian://BPM-install` link to a handler that
  doesn't exist), `applyRibbonConfigToMemory` ignores its arguments, `savePluginAndExport` is just `saveSettings`.
- Upstream branding baked in: `bpm-eondr-plugin` auto-tag, hardcoded QQ support-group link (`SUPPORT_QQ_GROUP_URL`),
  Afdian funding link, bilibili tutorial link.

## Open questions

- Answered: native ribbon persistence does *not* survive lazy loading (see internals); the fix is to re-apply it by id.
- Does `require("electron")` (top-level import in `utils.ts`) behave on mobile? The plugin claims mobile support, so presumably
  it resolves harmlessly, but nothing in the code guards it.
- BPM-started plugins still never get `onConfigFileChange()` (Obsidian only calls it for ids in `enabledPlugins`), so
  e.g. Obsidian Sync updating their data.json goes unnoticed until restart. Could BPM forward those raw events itself?
