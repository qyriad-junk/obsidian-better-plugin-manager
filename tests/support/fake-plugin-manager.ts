import { Events } from "obsidian";
import type { PluginManifest } from "obsidian";

/**
 * In-memory stand-in for Obsidian's `app.plugins` (its internal PluginManager).
 *
 * Mirrors the semantics verified against Obsidian 1.13.7's app.js (see docs/codebase-notes.md, "Obsidian internals"):
 * - `enabledPlugins` is the *persisted startup list*, not "what's running"; `plugins` is what's running.
 * - `enablePlugin` / `disablePlugin` only load/unload. `enablePlugin` returns false if the manifest isn't known
 *   (i.e. files written but `loadManifests()` not called yet), and is idempotent for loaded plugins.
 * - `*AndSave` change `enabledPlugins` and save it; `saveConfig()` writes `Array.from(enabledPlugins)`.
 * - `enabledPlugins` is never re-read from disk at runtime; only `startup()` (Obsidian launching) reads it.
 * - `didChange()` triggers "changed" asynchronously (Obsidian debounces it with a 0 ms timeout).
 *
 * Simplification: `requestSaveConfig()` saves immediately instead of after a 1 s debounce.
 */
export class FakePluginManager extends Events {
	manifests: Record<string, PluginManifest> = {};
	plugins: Record<string, { id: string; userEnabled: boolean }> = {};
	enabledPlugins = new Set<string>();

	/** Plugin folders present on disk; `loadManifests()` copies them into `manifests`. */
	installed: Record<string, PluginManifest> = {};
	/** Contents of community-plugins.json. */
	communityPluginsOnDisk: string[] = [];
	/** Everything that happened, in order: "load:<id>", "unload:<id>", "save". */
	log: string[] = [];

	private changeTimer: ReturnType<typeof setTimeout> | null = null;

	/** Test setup: put a plugin's files on disk. Obsidian won't know about it until loadManifests(). */
	install(id: string, extra: Partial<PluginManifest> = {}): this {
		this.installed[id] = { id, name: id, version: "1.0.0", minAppVersion: "1.0.0", description: "", author: "", ...extra } as PluginManifest;
		return this;
	}

	/** Simulate Obsidian launching: read community-plugins.json, load manifests, enable each listed plugin in turn. */
	async startup(): Promise<void> {
		this.plugins = {};
		this.enabledPlugins = new Set(this.communityPluginsOnDisk);
		await this.loadManifests();
		for (const id of this.communityPluginsOnDisk) await this.enablePlugin(id);
	}

	async loadManifests(): Promise<void> {
		this.manifests = Object.fromEntries(Object.entries(this.installed).map(([id, manifest]) => [id, { ...manifest }]));
	}

	async enablePlugin(id: string, userEnable = false): Promise<boolean> {
		if (!this.manifests[id]) return false;
		if (!this.plugins[id]) {
			this.plugins[id] = { id, userEnabled: userEnable };
			this.log.push(`load:${id}`);
		}
		this.didChange();
		return true;
	}

	async disablePlugin(id: string, _userDisable = false): Promise<void> {
		if (this.plugins[id]) {
			delete this.plugins[id];
			this.log.push(`unload:${id}`);
		}
		this.didChange();
	}

	async enablePluginAndSave(id: string): Promise<boolean> {
		const ok = await this.enablePlugin(id, true);
		if (ok) {
			this.enabledPlugins.add(id);
			this.requestSaveConfig();
		}
		return ok;
	}

	async disablePluginAndSave(id: string): Promise<void> {
		this.enabledPlugins.delete(id);
		this.requestSaveConfig();
		await this.disablePlugin(id, true);
	}

	async saveConfig(): Promise<void> {
		this.communityPluginsOnDisk = Array.from(this.enabledPlugins);
		this.log.push("save");
	}

	requestSaveConfig(): void {
		void this.saveConfig();
	}

	async uninstallPlugin(id: string): Promise<void> {
		await this.disablePluginAndSave(id);
		delete this.installed[id];
		delete this.manifests[id];
	}

	async loadPlugin(id: string): Promise<void> {
		await this.enablePlugin(id);
	}

	async installPlugin(): Promise<void> {
		throw new Error("FakePluginManager.installPlugin: not modelled");
	}

	private didChange(): void {
		if (this.changeTimer) return;
		this.changeTimer = setTimeout(() => {
			this.changeTimer = null;
			this.trigger("changed");
		}, 0);
	}

	/** Await pending "changed" events (and anything else queued behind a 0 ms timeout). */
	async settle(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	loaded(): string[] {
		return Object.keys(this.plugins).sort();
	}
}
