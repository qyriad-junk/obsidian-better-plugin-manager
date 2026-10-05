# Headless Obsidian sandbox

Runs a real Obsidian desktop build (Linux, under Xvfb) against a throwaway vault with this checkout's BPM build
linked in, and drives it over the Chrome DevTools Protocol. It's for verifying behaviour where no Obsidian GUI is
available (CI, cloud containers). On a desktop it works too, but your normal Obsidian is the nicer test bed.

Needs: Linux x64, `xvfb-run`, `curl`, Node, and the usual Electron runtime libraries (GTK 3, NSS, libgbm, ALSA).
Nothing touches your real Obsidian config: everything lives in `.sandbox/` (gitignored), including Obsidian's
`HOME`/`XDG_CONFIG_HOME`.

```sh
npm run build                          # or `npm run dev` in another terminal; the vault symlinks main.js etc.
scripts/sandbox/setup.sh               # download Obsidian (OBSIDIAN_VERSION, default 1.13.7), create the vault
scripts/sandbox/launch.sh              # start it; restricted mode is turned off for you
node scripts/sandbox/obsidian.mjs eval 'Object.keys(app.plugins.plugins)'
node scripts/sandbox/obsidian.mjs command better-plugins-manager:manager-view
node scripts/sandbox/obsidian.mjs screenshot .sandbox/manager.png
node scripts/sandbox/obsidian.mjs reload   # a full app reload: runs Obsidian's whole startup again
scripts/sandbox/launch.sh stop
scripts/sandbox/setup.sh --fresh       # reset the vault and Obsidian's config (keeps the download)
```

`eval` takes an expression and `run` takes an async function body (use `return`); both print the result as JSON and
have Obsidian's `app` in scope. After rebuilding BPM, reload the plugin
(`run 'await app.plugins.disablePlugin("better-plugins-manager"); await app.plugins.enablePlugin("better-plugins-manager")'`)
or `reload` the whole app.

## Fake plugins

```sh
node scripts/sandbox/make-plugin.mjs sheet-music --ribbon music:"Sheet music" --onload-ms 300
```

writes a minimal plugin into the vault: optional ribbon icons, and an optional busy-wait in `onload` to stand in for a
heavy plugin. Every load is recorded in `window.__bpmSandboxLoads` as `{ id, startedAt, finishedAt, layoutReady }`
(milliseconds since page load), which shows *when* something got started relative to the workspace becoming ready.
New plugins need `app.plugins.loadManifests()` (or a `reload`) before Obsidian sees them.

## Limits

- `api.github.com` may be unreachable from sandboxed environments, so GitHub install/update flows can't be exercised.
- One window, desktop layout only; mobile code paths (`Platform.isMobile`) don't run.
- If `launch.sh` reports a CLI-socket `EINVAL` in `.sandbox/obsidian.log`, the sandbox path is too long for a Unix
  socket; it's harmless (only Obsidian's own CLI is affected). Set `BPM_SANDBOX` to a shorter path to silence it.
