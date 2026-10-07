import type { EventRef } from "obsidian";
import { BPM_IGNORE_TAG } from "./data/types";
import type { Delay, ManagerPlugin } from "./data/types";
import type { ObsidianPluginRegistry } from "./obsidian-internals";

/**
 * The one place that decides which community plugins run, and how they get started.
 *
 * Three things that are easy to conflate, kept apart here:
 *
 * - **wanted**: the user wants this plugin running in this vault. The source of truth is BPM's own record
 *   (`ManagerPlugin.enabled`), in delay mode and outside it alike.
 * - **native startup list**: what Obsidian itself loads at launch, i.e. `app.plugins.enabledPlugins`, persisted to
 *   community-plugins.json by `saveConfig()`. BPM *derives* it: BPM itself, `bpm-ignore` plugins as the user left
 *   them, and, outside delay mode, every wanted plugin. In delay mode BPM starts wanted plugins itself instead.
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
	readonly settings: { DELAY: boolean; DELAYS: Delay[]; Plugins: ManagerPlugin[] };
	/** Persist BPM's settings (data.json). */
	saveSettings(): Promise<void>;
	/** Create the BPM record for an installed plugin that doesn't have one yet. */
	createRecord(id: string, wanted: boolean): ManagerPlugin;
}

export interface SetWantedOptions {
	/**
	 * True when the user flipped this plugin on or off. Matches what Obsidian's own toggle does: the plugin's
	 * `onUserEnable()` runs on enable, and its views' panes are closed on disable. False for BPM's own
	 * bookkeeping (troubleshooting, imports), which shouldn't trigger either.
	 */
	userInitiated?: boolean;
}

type Timer = number;

export class PluginStartup {
	private readonly host: PluginStartupHost;
	/** The native startup list as BPM last left it, to tell the user's native toggles apart from BPM's own writes. */
	private knownNativeList = new Set<string>();
	/** Plugins tagged bpm-ignore as of the last reconcile, to notice the tag being added or removed anywhere. */
	private knownIgnored = new Set<string>();
	/** What's running as far as BPM knows (it updates this *before* each load/unload it causes). */
	private knownLoaded = new Set<string>();
	private changeRef: EventRef | null = null;
	private delayedStarts = new Map<string, Timer>();

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

	/** Whether BPM (rather than Obsidian) will start this plugin at the next launch. */
	isStartedByBpm(id: string): boolean {
		return this.host.settings.DELAY && this.isManaged(id);
	}

	/** Seconds BPM waits before starting this plugin at launch (delay mode only). */
	getStartDelaySeconds(id: string): number {
		const delayId = this.getRecord(id)?.delay;
		const time = this.host.settings.DELAYS.find((delay) => delay.id === delayId)?.time;
		return typeof time === "number" && Number.isFinite(time) && time > 0 ? time : 0;
	}

	// ---------------------------------------------------------------------------------------------
	// The native startup list

	private shouldBeOnNativeList(id: string): boolean {
		if (id === this.host.selfId) return this.registry.enabledPlugins.has(id);
		// Ignored plugins stay exactly as the user left them natively.
		if (this.isIgnored(id)) return this.registry.enabledPlugins.has(id);
		if (this.host.settings.DELAY) return false;
		return this.isInstalled(id) && this.isWanted(id);
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
	 * - Added to the native list: wanted. (In delay mode, the next reconcile hands it back to BPM; it keeps running,
	 *   so Obsidian's toggle, which shows running state, doesn't flip back.)
	 * - Removed from the native list, or unloaded without BPM doing it: not wanted.
	 *
	 * Loads BPM didn't cause aren't adopted on their own: native enables also add to the native list, and anything
	 * else (another plugin starting one) isn't a statement of intent.
	 */
	adoptExternalChanges(): boolean {
		const native = new Set(this.registry.enabledPlugins);
		const loaded = new Set(Object.keys(this.registry.plugins ?? {}));
		const external = (id: string) => id !== this.host.selfId && !this.isIgnored(id);
		let changed = false;
		for (const id of native) {
			if (!this.knownNativeList.has(id) && external(id)) changed = this.setRecordWanted(id, true) || changed;
		}
		for (const id of this.knownNativeList) {
			if (!native.has(id) && external(id)) changed = this.setRecordWanted(id, false) || changed;
		}
		for (const id of this.knownLoaded) {
			if (!loaded.has(id) && external(id)) changed = this.setRecordWanted(id, false) || changed;
		}
		this.knownNativeList = native;
		this.knownLoaded = loaded;
		return changed;
	}

	/** Load a plugin, noting that BPM caused it. */
	private async load(id: string, userInitiated: boolean): Promise<boolean> {
		this.knownLoaded.add(id);
		const ok = await this.registry.enablePlugin(id, userInitiated);
		if (!ok && !this.isLoaded(id)) this.knownLoaded.delete(id);
		return ok;
	}

	/** Unload a plugin, noting that BPM caused it. */
	private async unload(id: string, userInitiated: boolean): Promise<void> {
		this.knownLoaded.delete(id);
		await this.registry.disablePlugin(id, userInitiated);
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
	 *    while BPM wasn't watching; outside delay mode, a managed plugin *missing* from it was disabled natively.
	 * 2. Re-derive the native startup list (in delay mode this moves natively-enabled plugins under BPM's control
	 *    from the next launch on).
	 * 3. In delay mode, schedule the wanted plugins that Obsidian didn't start.
	 * 4. Watch for native toggles from now on.
	 */
	async start(): Promise<void> {
		this.knownIgnored = this.currentlyIgnored();
		this.knownLoaded = new Set(Object.keys(this.registry.plugins ?? {}));
		let recordsChanged = false;
		for (const id of Object.keys(this.registry.manifests)) {
			if (!this.isManaged(id)) continue;
			if (this.registry.enabledPlugins.has(id)) {
				recordsChanged = this.setRecordWanted(id, true) || recordsChanged;
			} else if (!this.host.settings.DELAY) {
				recordsChanged = this.setRecordWanted(id, false) || recordsChanged;
			}
		}
		await this.syncNativeStartupList();
		if (recordsChanged) await this.host.saveSettings();

		if (this.host.settings.DELAY) this.scheduleDelayedStarts();

		this.changeRef = this.registry.on("changed", () => {
			if (this.adoptExternalChanges()) void this.host.saveSettings();
		});
	}

	private scheduleDelayedStarts(): void {
		for (const id of Object.keys(this.registry.manifests)) {
			if (!this.isManaged(id) || !this.isWanted(id) || this.isLoaded(id)) continue;
			this.scheduleStart(id, this.getStartDelaySeconds(id));
		}
	}

	private scheduleStart(id: string, delaySeconds: number): void {
		this.cancelScheduledStart(id);
		const timer = window.setTimeout(() => {
			this.delayedStarts.delete(id);
			if (this.isWanted(id) && !this.isLoaded(id)) void this.load(id, false);
		}, delaySeconds * 1000);
		this.delayedStarts.set(id, timer);
	}

	private cancelScheduledStart(id: string): void {
		const timer = this.delayedStarts.get(id);
		if (timer !== undefined) window.clearTimeout(timer);
		this.delayedStarts.delete(id);
	}

	/** Ids BPM has scheduled to start but hasn't started yet. */
	pendingStarts(): string[] {
		return Array.from(this.delayedStarts.keys());
	}

	/**
	 * Called from BPM's onunload. Obsidian never unloads plugins on quit, so this only runs when BPM itself is
	 * disabled, reloaded or updated. Hand every wanted plugin back to Obsidian's native startup list (and start any
	 * still waiting on a delay), so they keep working without BPM. If BPM comes back, its onload takes them over again.
	 */
	stop(): void {
		if (this.changeRef) this.registry.offref(this.changeRef);
		this.changeRef = null;
		const pending = this.pendingStarts();
		for (const id of pending) this.cancelScheduledStart(id);

		if (!this.host.settings.DELAY) return;
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
	 * Switch delay mode. Only the native startup list changes (it takes effect at the next launch); nothing is
	 * unloaded or reloaded. Turning delay mode off starts anything still waiting on its delay right away.
	 */
	async setDelayMode(enabled: boolean): Promise<void> {
		this.host.settings.DELAY = enabled;
		if (!enabled) {
			const pending = this.pendingStarts();
			for (const id of pending) {
				this.cancelScheduledStart(id);
				if (this.isWanted(id)) await this.load(id, false);
			}
		}
		await this.syncNativeStartupList();
		await this.host.saveSettings();
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
