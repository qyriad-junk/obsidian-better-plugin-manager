import type { EventRef } from "obsidian";
import { BPM_IGNORE_TAG } from "./data/types";
import type { ManagerPlugin } from "./data/types";
import type { ObsidianPluginRegistry } from "./obsidian-internals";
import { DEFAULT_STARTUP_TIER, isStartupTier, STARTUP_TIERS } from "./startup-tiers";
import type { StartupTier } from "./startup-tiers";

/**
 * The one place that decides which community plugins run, and how they get started.
 *
 * Three things that are easy to conflate, kept apart here:
 *
 * - **wanted**: the user wants this plugin running in this vault. The source of truth is BPM's own record
 *   (`ManagerPlugin.enabled`), in staged-startup mode and outside it alike.
 * - **native startup list**: what Obsidian itself loads at launch, i.e. `app.plugins.enabledPlugins`, persisted to
 *   community-plugins.json by `saveConfig()`. BPM *derives* it: BPM itself, `bpm-ignore` plugins as the user left
 *   them, and every wanted plugin, except, in staged-startup mode, those whose {@link StartupTier} says
 *   BPM starts them after the workspace is ready.
 * - **loaded**: running right now (`app.plugins.plugins[id]`).
 *
 * `bpm-ignore` means "Obsidian's native startup list is authoritative for this plugin": BPM mirrors its native state
 * into the record and never schedules it.
 *
 * BPM never calls `enablePluginAndSave` / `disablePluginAndSave`, and every load/unload BPM causes goes through this
 * class. So a change BPM didn't make is the user toggling a plugin in Obsidian's own settings (or the CLI), and it's
 * adopted as their intent (see {@link PluginStartup.adoptExternalChanges}). Note that Obsidian's own toggle shows
 * whether a plugin is *running*: switching off a plugin BPM started only unloads it, without touching the native list.
 *
 * Obsidian internals relied on here are documented in docs/codebase-notes.md and modelled by
 * tests/support/fake-plugin-manager.ts.
 */
export type PluginStartupRegistry = Pick<ObsidianPluginRegistry, "manifests" | "plugins" | "enabledPlugins" | "enablePlugin" | "disablePlugin" | "loadManifests"> & {
	saveConfig(): Promise<void>;
	on(name: "changed", callback: () => void): EventRef;
	offref(ref: EventRef): void;
};

export interface PluginStartupHost {
	/** BPM's own plugin id. BPM is always on the native startup list and is never touched here. */
	readonly selfId: string;
	readonly registry: PluginStartupRegistry;
	/** Read on every use, since the settings object can be replaced (e.g. by a transfer-pack import). */
	readonly settings: { STAGED_STARTUP: boolean; Plugins: ManagerPlugin[] };
	/** Persist BPM's settings (data.json). */
	saveSettings(): Promise<void>;
	/** Create the BPM record for an installed plugin that doesn't have one yet. */
	createRecord(id: string, wanted: boolean): ManagerPlugin;
	/** `<configDir>/plugins`, Obsidian's plugin folder. */
	readonly pluginFolder: string;
	/** Run `callback` once the workspace layout is ready (right away if it already is). */
	onLayoutReady(callback: () => void): void;
	/** Debug logging (only shown when BPM's debug setting is on). */
	log(message: string): void;
	/** Subscribe to the vault's "raw" events (every file change seen on disk, config dir included). Returns an unsubscribe. */
	onVaultRaw(callback: (path: string) => void): () => void;
	/**
	 * Re-apply saved workspace layout state that a plugin started after the layout loaded would otherwise lose (its
	 * ribbon icons' hidden flags and order; see src/ribbon-state.ts). Called before and after every load BPM causes;
	 * does nothing until the layout is ready.
	 */
	syncLateStartLayout(): void;
}

export interface SetWantedOptions {
	/**
	 * True when the user flipped this plugin on or off. Matches what Obsidian's own toggle does: the plugin's
	 * `onUserEnable()` runs on enable, and its views' panes are closed on disable. False for BPM's own
	 * bookkeeping (troubleshooting, imports), which shouldn't trigger either.
	 */
	userInitiated?: boolean;
}

export class PluginStartup {
	private readonly host: PluginStartupHost;
	/** The native startup list as BPM last left it, to tell the user's native toggles apart from BPM's own writes. */
	private knownNativeList = new Set<string>();
	/** Plugins tagged bpm-ignore as of the last reconcile, to notice the tag being added or removed anywhere. */
	private knownIgnored = new Set<string>();
	/**
	 * The running plugin instances as of the last look. When one disappears it was unloaded, and Obsidian's
	 * unloadPlugin records on the instance whether the user switched it off (`_userDisabled`).
	 */
	private knownInstances = new Map<string, unknown>();
	/** Loads BPM has in flight, so a second request for the same plugin waits for the first instead of loading it twice. */
	private loading = new Map<string, Promise<boolean>>();
	private changeRef: EventRef | null = null;
	private stopWatchingRaw: (() => void) | null = null;
	/** Plugins BPM will start once the workspace is ready (staged startup), and hasn't yet. */
	private pending = new Set<string>();
	/** Bumped by stop(), so a staged startup still in progress knows to give up. */
	private generation = 0;

	constructor(host: PluginStartupHost) {
		this.host = host;
	}

	private get registry(): PluginStartupRegistry {
		return this.host.registry;
	}

	// ---------------------------------------------------------------------------------------------
	// Queries

	getRecord(id: string): ManagerPlugin | undefined {
		return this.host.settings.Plugins.find((plugin) => plugin.id === id);
	}

	isInstalled(id: string): boolean {
		return Boolean(this.registry.manifests[id]);
	}

	/** Tagged `bpm-ignore`: Obsidian's native startup list is authoritative, BPM never schedules it. */
	isIgnored(id: string): boolean {
		return Boolean(this.getRecord(id)?.tags?.includes(BPM_IGNORE_TAG));
	}

	/** BPM decides whether and when this plugin starts. */
	isManaged(id: string): boolean {
		return id !== this.host.selfId && !this.isIgnored(id);
	}

	isWanted(id: string): boolean {
		if (id === this.host.selfId) return true;
		if (this.isIgnored(id)) return this.registry.enabledPlugins.has(id);
		const record = this.getRecord(id);
		return record ? record.enabled : this.registry.enabledPlugins.has(id);
	}

	isLoaded(id: string): boolean {
		return Boolean(this.registry.plugins?.[id]);
	}

	/** When this plugin starts in staged-startup mode. */
	getStartupTier(id: string): StartupTier {
		const tier = this.getRecord(id)?.startupTier;
		return isStartupTier(tier) ? tier : DEFAULT_STARTUP_TIER;
	}

	/** Whether BPM (rather than Obsidian) will start this plugin at the next launch. */
	isStartedByBpm(id: string): boolean {
		return this.host.settings.STAGED_STARTUP && this.isManaged(id) && this.getStartupTier(id) !== "native";
	}

	// ---------------------------------------------------------------------------------------------
	// The native startup list

	private shouldBeOnNativeList(id: string): boolean {
		if (id === this.host.selfId) return this.registry.enabledPlugins.has(id);
		// Ignored plugins stay exactly as the user left them natively.
		if (this.isIgnored(id)) return this.registry.enabledPlugins.has(id);
		return this.isInstalled(id) && this.isWanted(id) && !this.isStartedByBpm(id);
	}

	/**
	 * The native startup list as it should be. Keeps the current order (Obsidian starts plugins in list order) and
	 * appends newly added plugins in BPM's record order.
	 */
	desiredNativeList(): string[] {
		const current = Array.from(this.registry.enabledPlugins);
		const desired = current.filter((id) => this.shouldBeOnNativeList(id));
		const present = new Set(desired);
		for (const record of this.host.settings.Plugins) {
			if (!present.has(record.id) && this.shouldBeOnNativeList(record.id)) {
				desired.push(record.id);
				present.add(record.id);
			}
		}
		return desired;
	}

	/**
	 * Make the native startup list match {@link desiredNativeList}, persisting it only if it changed.
	 * Never loads or unloads anything: what's running right now is unaffected.
	 */
	async syncNativeStartupList(): Promise<void> {
		const desired = this.desiredNativeList();
		const current = Array.from(this.registry.enabledPlugins);
		const lastKnown = this.knownNativeList;
		// The in-memory set may already have been edited directly (bpm-ignore plugins), so compare against what was
		// last persisted too, not just the set.
		const unchanged = desired.length === current.length && desired.every((id, index) => id === current[index])
			&& desired.length === lastKnown.size && desired.every((id) => lastKnown.has(id));
		// Update the set and what we remember of it in one synchronous step, so the "changed" event that follows
		// some later load/unload can't mistake BPM's own write for a native toggle.
		this.knownNativeList = new Set(desired);
		if (unchanged) return;
		this.registry.enabledPlugins.clear();
		for (const id of desired) this.registry.enabledPlugins.add(id);
		await this.registry.saveConfig();
	}

	/**
	 * Adopt changes BPM didn't make: the user toggled a plugin in Obsidian's own settings (or the CLI). Called on
	 * every `app.plugins` "changed" event.
	 *
	 * - Added to the native list: wanted. (In staged-startup mode the next reconcile takes it off the list again unless
	 *   its tier is `native`, and BPM starts it from then on; it keeps running, so Obsidian's toggle, which shows running
	 *   state, doesn't flip back.)
	 * - Removed from the native list: not wanted.
	 * - Unloaded by the user (Obsidian's own toggle, which marks the instance `_userDisabled`): not wanted. This is how
	 *   switching off a plugin BPM started looks, since it isn't on the native list. Other unloads are reloads (BPM's
	 *   restart, Obsidian's or BPM's updater, hot-reload tools) or BPM's own bookkeeping, and say nothing about intent.
	 *
	 * Loads aren't adopted on their own: native enables also add to the native list, and anything else (another plugin
	 * starting one) isn't a statement of intent.
	 */
	adoptExternalChanges(): boolean {
		const native = new Set(this.registry.enabledPlugins);
		const instances = new Map<string, unknown>(Object.entries(this.registry.plugins ?? {}));
		const external = (id: string) => id !== this.host.selfId && !this.isIgnored(id);
		let changed = false;
		for (const id of native) {
			if (!this.knownNativeList.has(id) && external(id)) changed = this.setRecordWanted(id, true) || changed;
		}
		for (const id of this.knownNativeList) {
			if (!native.has(id) && external(id)) changed = this.setRecordWanted(id, false) || changed;
		}
		for (const [id, instance] of this.knownInstances) {
			if (instances.has(id) || !external(id) || !wasUserDisabled(instance)) continue;
			changed = this.setRecordWanted(id, false) || changed;
		}
		this.knownNativeList = native;
		this.knownInstances = instances;
		return changed;
	}

	/**
	 * Load a plugin. If BPM is already loading it, wait for that instead: Obsidian's loadPlugin only notices an existing
	 * instance once it's done reading main.js, so two overlapping loads would run the plugin twice.
	 */
	private load(id: string, userInitiated: boolean): Promise<boolean> {
		const inFlight = this.loading.get(id);
		if (inFlight) return inFlight;
		const loading = (async () => {
			this.syncLateStartLayout();
			try {
				return await this.registry.enablePlugin(id, userInitiated);
			} finally {
				this.loading.delete(id);
				this.syncLateStartLayout();
			}
		})();
		this.loading.set(id, loading);
		return loading;
	}

	private async unload(id: string, userInitiated: boolean): Promise<void> {
		await this.registry.disablePlugin(id, userInitiated);
	}

	/** Re-apply the saved ribbon layout around a load. Cosmetic: a failure must not stop the plugin from starting. */
	private syncLateStartLayout(): void {
		try {
			this.host.syncLateStartLayout();
		} catch (error) {
			console.error("[BPM] Couldn't re-apply the saved ribbon layout", error);
		}
	}

	/**
	 * Run `during` with the plugin unloaded (e.g. while replacing its files or its data.json), then load it again if
	 * it was running. Neither step is mistaken for the user toggling it.
	 */
	async whileUnloaded(id: string, during: () => Promise<void>): Promise<boolean> {
		const wasLoaded = this.isLoaded(id);
		if (wasLoaded) await this.unload(id, false);
		try {
			await during();
		} finally {
			if (wasLoaded) await this.load(id, false);
		}
		return wasLoaded;
	}

	/** Returns whether anything changed (including creating the record). */
	private setRecordWanted(id: string, wanted: boolean): boolean {
		if (!this.isInstalled(id)) return false;
		const existing = this.getRecord(id);
		if (!existing) {
			this.host.createRecord(id, wanted);
			return true;
		}
		if (existing.enabled === wanted) return false;
		existing.enabled = wanted;
		return true;
	}

	private currentlyIgnored(): Set<string> {
		return new Set(this.host.settings.Plugins
			.filter((record) => record.id !== this.host.selfId && record.tags?.includes(BPM_IGNORE_TAG))
			.map((record) => record.id));
	}

	/**
	 * Apply bpm-ignore being added or removed since last time (tags are edited in several places), then re-derive
	 * the native startup list. Manager.saveSettings() calls this before every save, so no edit path can leave the
	 * native list stale.
	 *
	 * Newly ignored: the plugin goes on/off the native list according to whether it was wanted. Newly un-ignored:
	 * it's wanted iff it was on the native list or running.
	 */
	async reconcile(): Promise<void> {
		const ignored = this.currentlyIgnored();
		for (const id of ignored) {
			if (this.knownIgnored.has(id)) continue;
			this.cancelScheduledStart(id);
			if (this.getRecord(id)?.enabled) this.registry.enabledPlugins.add(id);
			else this.registry.enabledPlugins.delete(id);
		}
		for (const id of this.knownIgnored) {
			if (ignored.has(id)) continue;
			const record = this.getRecord(id);
			if (record) record.enabled = this.registry.enabledPlugins.has(id) || this.isLoaded(id);
		}
		this.knownIgnored = ignored;
		await this.syncNativeStartupList();
	}

	// ---------------------------------------------------------------------------------------------
	// Lifecycle

	/**
	 * Called once from BPM's onload, after records have been reconciled with the installed plugins.
	 *
	 * 1. Adopt the native startup list Obsidian just launched with. Any BPM-managed plugin on it was enabled natively
	 *    while BPM wasn't watching; outside staged-startup mode, a managed plugin *missing* from it was disabled natively.
	 *    (In staged-startup mode a missing plugin is normal: BPM may start it.)
	 * 2. Re-derive the native startup list (in staged-startup mode this moves natively-enabled plugins under BPM's control
	 *    from the next launch on, unless their tier is `native`).
	 * 3. In staged-startup mode, start the wanted plugins that Obsidian didn't, once the workspace is ready.
	 * 4. Watch for native toggles from now on.
	 */
	async start(): Promise<void> {
		this.knownIgnored = this.currentlyIgnored();
		this.knownInstances = new Map(Object.entries(this.registry.plugins ?? {}));
		let recordsChanged = false;
		for (const id of Object.keys(this.registry.manifests)) {
			if (!this.isManaged(id)) continue;
			if (this.registry.enabledPlugins.has(id)) {
				recordsChanged = this.setRecordWanted(id, true) || recordsChanged;
			} else if (!this.host.settings.STAGED_STARTUP) {
				recordsChanged = this.setRecordWanted(id, false) || recordsChanged;
			}
		}
		await this.syncNativeStartupList();
		if (recordsChanged) await this.host.saveSettings();

		if (this.host.settings.STAGED_STARTUP) {
			for (const id of Object.keys(this.registry.manifests)) {
				if (this.isManaged(id) && this.isWanted(id) && !this.isLoaded(id)) this.pending.add(id);
			}
			const generation = this.generation;
			this.host.onLayoutReady(() => void this.runStagedStartup(generation));
		}

		this.stopWatchingRaw = this.host.onVaultRaw((path) => this.forwardConfigFileChange(path));

		this.changeRef = this.registry.on("changed", () => {
			if (this.adoptExternalChanges()) void this.host.saveSettings();
		});
	}

	/**
	 * When a plugin's data.json changes on disk (Obsidian Sync, Syncthing, git…), Obsidian calls that plugin's
	 * onConfigFileChange(), which in turn calls the public onExternalSettingsChange() if the file is newer than the
	 * plugin's own last save. But Obsidian only does that for plugins on its native startup list (PluginManager.onRaw
	 * checks enabledPlugins), so plugins BPM started would never hear about it. Forward it for exactly those.
	 * The path rule mirrors Obsidian's: `<pluginFolder>/<id>/data.json`.
	 */
	private forwardConfigFileChange(path: string): void {
		const prefix = `${this.host.pluginFolder}/`;
		if (!path.startsWith(prefix) || !path.endsWith("/data.json")) return;
		const id = path.slice(prefix.length, -"/data.json".length);
		if (id.includes("/") || this.registry.enabledPlugins.has(id)) return; // Obsidian handles native ones itself.
		const plugin = this.registry.plugins?.[id] as { onConfigFileChange?: () => void } | undefined;
		plugin?.onConfigFileChange?.();
	}

	/**
	 * Staged startup, once the workspace is ready: start the pending plugins one at a time, each turn taking whichever
	 * comes first in {@link pendingStarts} order *right now* (tier order, then BPM's list order), so changing a pending
	 * plugin's tier counts until it has started. `native`-tier plugins that Obsidian didn't start (just moved to that
	 * tier, not on the native list yet, or failed natively) go first. Before each start: a yield to the UI, or for
	 * `background` plugins, a wait for Obsidian to be idle ({@link TIER_PACING}).
	 */
	private async runStagedStartup(generation: number): Promise<void> {
		const readyAt = performance.now();
		const stillRunning = () => generation === this.generation;
		let startedAny = false;
		for (let next = this.pendingStarts()[0]; next !== undefined; next = this.pendingStarts()[0]) {
			await TIER_PACING[this.getStartupTier(next)]();
			if (!stillRunning()) return;
			// The queue may have changed while waiting (tier changes, plugins started or switched off meanwhile).
			const id = this.pendingStarts()[0];
			if (id === undefined) break;
			this.pending.delete(id);
			if (!this.isWanted(id) || this.isLoaded(id)) continue;
			const startedAt = performance.now();
			let ok = false;
			try {
				ok = await this.load(id, false);
			} catch (error) {
				console.error(`[BPM] Starting ${id} failed`, error);
			}
			startedAny = true;
			if (!ok) console.warn(`[BPM] Obsidian didn't start ${id} (it may be desktop-only, need a newer Obsidian, or have failed in its onload).`);
			this.host.log(`${ok ? "started" : "couldn't start"} ${id} (${this.getStartupTier(id)}) `
				+ `${Math.round(startedAt - readyAt)} ms after layout-ready; onload took ${Math.round(performance.now() - startedAt)} ms`);
		}
		// Some plugins add their ribbon icons a little after onload (e.g. from onLayoutReady): catch those too.
		if (startedAny) window.setTimeout(() => { if (stillRunning()) this.syncLateStartLayout(); }, 2000);
	}

	private cancelScheduledStart(id: string): void {
		this.pending.delete(id);
	}

	/** Plugins BPM will start once the workspace is ready but hasn't yet, in the order it will start them. */
	pendingStarts(): string[] {
		const listOrder = new Map(this.host.settings.Plugins.map((record, index) => [record.id, index]));
		const tierOrder = (id: string) => STARTUP_TIERS.indexOf(this.getStartupTier(id));
		return Array.from(this.pending).sort((a, b) => tierOrder(a) - tierOrder(b)
			|| (listOrder.get(a) ?? Infinity) - (listOrder.get(b) ?? Infinity));
	}

	/**
	 * Called from BPM's onunload. Obsidian never unloads plugins on quit, so this only runs when BPM itself is
	 * disabled, reloaded or updated. Hand every wanted plugin back to Obsidian's native startup list (and start any
	 * still waiting for their turn), so they keep working without BPM. If BPM comes back, its onload takes them over again.
	 */
	stop(): void {
		if (this.changeRef) this.registry.offref(this.changeRef);
		this.changeRef = null;
		this.stopWatchingRaw?.();
		this.stopWatchingRaw = null;
		this.generation++;
		const pending = this.pendingStarts();
		for (const id of pending) this.cancelScheduledStart(id);

		if (!this.host.settings.STAGED_STARTUP) return;
		let added = false;
		for (const record of this.host.settings.Plugins) {
			if (!this.isManaged(record.id) || !record.enabled || !this.isInstalled(record.id)) continue;
			if (!this.registry.enabledPlugins.has(record.id)) {
				this.registry.enabledPlugins.add(record.id);
				added = true;
			}
		}
		if (added) void this.registry.saveConfig();
		for (const id of pending) {
			if (this.isWanted(id)) void this.load(id, false);
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Changes

	/**
	 * Turn a plugin on or off: record the intent, load/unload it now, and update the native startup list.
	 * Works for `bpm-ignore` plugins too (troubleshooting needs that); for them only the native list is changed.
	 *
	 * Returns false if nothing could be done: BPM itself, a plugin that isn't installed, or Obsidian refusing to
	 * load it (e.g. desktop-only on mobile, or blocklisted). The intent isn't recorded in that case.
	 */
	async setWanted(id: string, wanted: boolean, options: SetWantedOptions = {}): Promise<boolean> {
		const changed = await this.applyWanted(id, wanted, options);
		if (changed === null) return false;
		await this.syncNativeStartupList();
		await this.host.saveSettings();
		return true;
	}

	/** {@link setWanted} for several plugins, with one save at the end. Returns the ids that were applied. */
	async setWantedMany(states: Record<string, boolean>, options: SetWantedOptions = {}, onEach?: (id: string) => void): Promise<string[]> {
		const applied: string[] = [];
		for (const [id, wanted] of Object.entries(states)) {
			if ((await this.applyWanted(id, wanted, options)) !== null) applied.push(id);
			onEach?.(id);
		}
		await this.syncNativeStartupList();
		await this.host.saveSettings();
		return applied;
	}

	/** Returns null if nothing could be done, otherwise whether the wanted state changed. */
	private async applyWanted(id: string, wanted: boolean, options: SetWantedOptions): Promise<boolean | null> {
		if (id === this.host.selfId || !this.isInstalled(id)) return null;
		const userInitiated = options.userInitiated ?? false;
		const wasWanted = this.isWanted(id);
		this.cancelScheduledStart(id);

		if (wanted && !this.isLoaded(id)) {
			const loaded = await this.load(id, userInitiated);
			if (!loaded) return null;
		} else if (!wanted && this.isLoaded(id)) {
			await this.unload(id, userInitiated);
		}

		const record = this.getRecord(id) ?? this.host.createRecord(id, wanted);
		record.enabled = wanted;
		if (this.isIgnored(id)) {
			// Native list is authoritative for ignored plugins: change it directly.
			if (wanted) this.registry.enabledPlugins.add(id);
			else this.registry.enabledPlugins.delete(id);
		}
		return wasWanted !== wanted;
	}

	/** Start a plugin for this session only, without changing whether it's wanted ("single start"). */
	async startOnce(id: string): Promise<boolean> {
		if (id === this.host.selfId || !this.isInstalled(id)) return false;
		this.cancelScheduledStart(id);
		return this.load(id, true);
	}

	/** Unload and load a running plugin again. Doesn't change whether it's wanted or the native startup list. */
	async restart(id: string): Promise<boolean> {
		if (id === this.host.selfId || !this.isLoaded(id)) return false;
		await this.unload(id, false);
		return this.load(id, false);
	}

	/**
	 * Switch staged-startup mode. Only the native startup list changes (it takes effect at the next launch);
	 * nothing is unloaded or reloaded. Turning it off starts anything still waiting for its turn right away.
	 */
	async setStagedStartup(enabled: boolean): Promise<void> {
		this.host.settings.STAGED_STARTUP = enabled;
		if (!enabled) {
			// Take them all off the queue first, so a staged startup still running doesn't start any of them as well.
			const pending = this.pendingStarts();
			for (const id of pending) this.cancelScheduledStart(id);
			for (const id of pending) {
				if (this.isWanted(id) && !this.isLoaded(id)) await this.load(id, false);
			}
		}
		await this.syncNativeStartupList();
		await this.host.saveSettings();
	}

	/**
	 * Set when plugins start in staged-startup mode. Takes effect at the next launch (the native startup list is
	 * updated now); a plugin still waiting for its turn this launch goes by its new tier. `bpm-ignore` plugins and BPM
	 * itself are skipped (Obsidian's native list decides for those). Returns the ids that were changed.
	 */
	async setStartupTier(ids: readonly string[], tier: StartupTier): Promise<string[]> {
		const changed: string[] = [];
		for (const id of ids) {
			if (!this.isManaged(id) || !this.isInstalled(id)) continue;
			const record = this.getRecord(id) ?? this.host.createRecord(id, this.isWanted(id));
			if (record.startupTier === tier) continue;
			record.startupTier = tier;
			changed.push(id);
		}
		if (changed.length === 0) return changed;
		await this.syncNativeStartupList();
		await this.host.saveSettings();
		return changed;
	}

	/**
	 * Add or remove `bpm-ignore`. Ignoring hands the plugin to Obsidian's native startup list in its current wanted
	 * state; un-ignoring takes it back under BPM with whatever state it had natively (see {@link reconcile}).
	 */
	async setIgnored(id: string, ignored: boolean): Promise<void> {
		if (id === this.host.selfId || !this.isInstalled(id)) return;
		if (ignored === this.isIgnored(id)) return;
		const record = this.getRecord(id) ?? this.host.createRecord(id, this.isWanted(id));
		record.tags = ignored ? [...record.tags, BPM_IGNORE_TAG] : record.tags.filter((tag) => tag !== BPM_IGNORE_TAG);
		await this.reconcile();
		await this.host.saveSettings();
	}

	/**
	 * After an install or update has written a plugin's files: make Obsidian read the new manifest, then bring the
	 * plugin to the state it should be in. A fresh install is wanted (that's why it was installed) unless
	 * `wantedIfNew` says otherwise; an update keeps its wanted state, and is reloaded if it was running, so the new
	 * code takes effect.
	 */
	async applyInstalledFiles(id: string, options: { wantedIfNew?: boolean } = {}): Promise<boolean> {
		const isNew = !this.getRecord(id) && !this.isInstalled(id);
		await this.registry.loadManifests();
		if (!this.isInstalled(id)) return false;

		const record = this.getRecord(id) ?? this.host.createRecord(id, options.wantedIfNew ?? true);
		if (isNew) record.enabled = options.wantedIfNew ?? true;

		let ok = true;
		if (this.isLoaded(id)) {
			await this.unload(id, false);
			ok = await this.load(id, false);
		} else if (this.isWanted(id)) {
			ok = await this.load(id, isNew);
		}
		await this.syncNativeStartupList();
		await this.host.saveSettings();
		return ok;
	}
}

/** What BPM waits for before starting a plugin of each tier in a staged startup. */
const TIER_PACING: Record<StartupTier, () => Promise<void>> = {
	"native": yieldToUi,
	"after-ready": yieldToUi,
	"background": waitForIdle,
};

/** Let Obsidian handle input and paint before the next plugin starts. */
function yieldToUi(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** Wait until Obsidian is idle (or a second has passed, so a busy app still gets there). */
function waitForIdle(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => resolve(), { timeout: 1000 });
		else window.setTimeout(resolve, 50);
	});
}

/** Whether Obsidian unloaded this plugin instance because the user switched it off (unloadPlugin's `userDisable`). */
function wasUserDisabled(instance: unknown): boolean {
	return Boolean(instance) && typeof instance === "object" && (instance as { _userDisabled?: unknown })._userDisabled === true;
}
