import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PluginStartup } from "../src/plugin-startup";
import type { PluginStartupHost, PluginStartupRegistry } from "../src/plugin-startup";
import type { ManagerPlugin } from "../src/data/types";
import { BPM_IGNORE_TAG } from "../src/data/types";
import type { StartupTier } from "../src/startup-tiers";
import { FakePluginManager } from "./support/fake-plugin-manager";

const BPM = "better-plugins-manager";

/** A vault: Obsidian's plugin manager plus BPM's settings, which survive "restarts" like data.json does. */
class Vault {
	plugins = new FakePluginManager();
	settings = { STAGED_STARTUP: false, Plugins: [] as ManagerPlugin[] };
	saves = 0;
	layoutSyncs = 0;
	startup!: PluginStartup;
	private layoutReady = false;
	private onReady: (() => void)[] = [];

	/** Startup tier given to records BPM creates. */
	private newRecordTier: StartupTier;

	constructor(ids: string[], { newRecordTier = "native" as StartupTier } = {}) {
		this.newRecordTier = newRecordTier;
		this.plugins.install(BPM);
		for (const id of ids) this.plugins.install(id);
	}

	record(id: string): ManagerPlugin {
		const record = this.settings.Plugins.find((plugin) => plugin.id === id);
		if (!record) throw new Error(`no record for ${id}`);
		return record;
	}

	private host(): PluginStartupHost {
		return {
			selfId: BPM,
			registry: this.plugins as unknown as PluginStartupRegistry,
			settings: this.settings,
			// Like Manager.saveSettings(): reconcile, then persist.
			saveSettings: async () => { await this.startup?.reconcile(); this.saves++; },
			pluginFolder: this.plugins.pluginFolder,
			onVaultRaw: (callback) => this.plugins.onVaultRaw(callback),
			syncLateStartLayout: () => { this.layoutSyncs++; },
			onLayoutReady: (callback) => {
				if (this.layoutReady) callback();
				else this.onReady.push(callback);
			},
			log: () => {},
			createRecord: (id, wanted) => {
				const record: ManagerPlugin = { id, name: id, desc: "", group: "", tags: [], enabled: wanted, startupTier: this.newRecordTier, note: "" };
				this.settings.Plugins.push(record);
				return record;
			},
		};
	}

	/**
	 * Launch Obsidian: read community-plugins.json and start what's listed (BPM's onload among them), then load the
	 * workspace layout, unless `untilLayoutReady` is false (then call {@link finishLayout}).
	 */
	async launch({ untilLayoutReady = true } = {}): Promise<void> {
		this.layoutReady = false;
		this.onReady = [];
		await this.plugins.startup();
		this.startup = new PluginStartup(this.host());
		await this.startup.start();
		if (untilLayoutReady) this.finishLayout();
	}

	finishLayout(): void {
		this.layoutReady = true;
		for (const callback of this.onReady.splice(0)) callback();
	}

	native(): string[] {
		return [...this.plugins.communityPluginsOnDisk].sort();
	}
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/**
 * Let pending 0 ms work run (e.g. Obsidian's "changed" event). Advances 1 ms because the fake clock doesn't fire 0 ms
 * timers that were scheduled by a timer firing during the same advanceTimersByTimeAsync(0).
 */
const settle = () => vi.advanceTimersByTimeAsync(1);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("normal mode", () => {
	test("startup adopts the native startup list as what's wanted", async () => {
		const vault = new Vault(["a", "b"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		vault.settings.Plugins.push({ id: "b", name: "b", desc: "", group: "", tags: [], enabled: true, startupTier: "native", note: "" });
		await vault.launch();
		expect(vault.startup.isWanted("a")).toBe(true);
		// b's record said enabled, but Obsidian didn't start it: it was disabled natively while BPM wasn't looking.
		expect(vault.startup.isWanted("b")).toBe(false);
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
	});

	test("setWanted loads/unloads now and updates the native startup list", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();

		expect(await vault.startup.setWanted("a", true, { userInitiated: true })).toBe(true);
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
		expect(vault.native()).toEqual([BPM, "a"].sort());
		expect(vault.plugins.plugins.a.userEnabled).toBe(true);

		await vault.startup.setWanted("a", false);
		expect(vault.plugins.loaded()).toEqual([BPM].sort());
		expect(vault.native()).toEqual([BPM]);
	});

	test("setWanted refuses what Obsidian won't load, and BPM itself", async () => {
		const vault = new Vault([]);
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();
		expect(await vault.startup.setWanted("not-installed", true)).toBe(false);
		expect(await vault.startup.setWanted(BPM, false)).toBe(false);
		expect(vault.plugins.loaded()).toEqual([BPM].sort());
	});
});

describe("staged startup", () => {
	test("Obsidian starts BPM, ignored and native-tier plugins; BPM starts the rest once the layout is ready", async () => {
		const vault = new Vault(["soon", "later", "with-obsidian", "ignored", "off"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "soon", "later", "with-obsidian", "ignored"];
		await vault.launch();
		vault.record("soon").startupTier = "after-ready";
		vault.record("later").startupTier = "background";
		await vault.startup.setIgnored("ignored", true);
		await vault.startup.setStagedStartup(true);

		await vault.launch({ untilLayoutReady: false });
		expect(vault.native()).toEqual([BPM, "ignored", "with-obsidian"].sort());
		expect(vault.plugins.loaded()).toEqual([BPM, "ignored", "with-obsidian"].sort());
		expect(vault.startup.pendingStarts()).toEqual(["soon", "later"]);
		await advance(60_000); // no clock: nothing starts until the workspace is ready
		expect(vault.plugins.loaded()).toEqual([BPM, "ignored", "with-obsidian"].sort());

		vault.finishLayout();
		await settle();
		expect(vault.plugins.loaded()).toEqual([BPM, "ignored", "soon", "with-obsidian"].sort());
		await advance(50); // background: when idle (no requestIdleCallback here, so a short timeout)
		expect(vault.plugins.loaded()).toEqual([BPM, "ignored", "later", "soon", "with-obsidian"].sort());
		expect(vault.plugins.loaded()).not.toContain("off");
	});

	test("one plugin at a time: after-ready in list order, then background, native-tier stragglers first", async () => {
		const vault = new Vault(["bg1", "r1", "bg2", "r2", "n1"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "bg1", "r1", "bg2", "r2", "n1"];
		await vault.launch(); // adopted; all BPM-started from the next launch
		vault.record("bg1").startupTier = "background";
		vault.record("bg2").startupTier = "background";
		vault.record("n1").startupTier = "native"; // native tier, but (like right after upgrading BPM) not on the native list
		await vault.startup.reconcile();
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch({ untilLayoutReady: false });
		expect(vault.plugins.loaded()).toEqual([BPM]);
		vault.plugins.log = [];

		vault.finishLayout();
		await vi.advanceTimersToNextTimerAsync();
		expect(vault.plugins.log).toEqual(["load:n1"]); // a yield to the UI before each start
		await advance(1000);
		expect(vault.plugins.log.filter((entry) => entry.startsWith("load:"))).toEqual(
			["load:n1", "load:r1", "load:r2", "load:bg1", "load:bg2"]);
	});

	test("a pending plugin's tier is read when its turn comes", async () => {
		const vault = new Vault(["a", "b"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a", "b"];
		await vault.launch();
		vault.record("a").startupTier = "background";
		await vault.launch({ untilLayoutReady: false });
		expect(vault.startup.pendingStarts()).toEqual(["b", "a"]);
		vault.record("a").startupTier = "after-ready";
		vault.record("b").startupTier = "background";
		vault.finishLayout();
		await settle();
		await settle();
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
	});

	test("late starts re-apply the saved workspace layout (ribbon) around each load", async () => {
		const vault = new Vault(["a"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await vault.launch();
		await vault.launch();
		vault.layoutSyncs = 0;
		await settle();
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
		expect(vault.layoutSyncs).toBe(2);
		await advance(2000); // and once more a little later, for icons added after onload
		expect(vault.layoutSyncs).toBe(3);
	});

	test("staged starts aren't user-initiated (no onUserEnable)", async () => {
		const vault = new Vault(["a"], { newRecordTier: "after-ready" });
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		vault.settings.STAGED_STARTUP = true;
		await vault.launch(); // a was on the native list: adopted, moved under BPM from the next launch
		await vault.launch();
		await settle();
		expect(vault.plugins.plugins.a?.userEnabled).toBe(false);
	});

	test("switching staged startup never reloads anything", async () => {
		const vault = new Vault(["a", "b"], { newRecordTier: "after-ready" });
		vault.plugins.communityPluginsOnDisk = [BPM, "a", "b"];
		await vault.launch();
		const logBefore = vault.plugins.log.filter((entry) => entry !== "save").length;

		await vault.startup.setStagedStartup(true);
		expect(vault.native()).toEqual([BPM]);
		await vault.startup.setStagedStartup(false);
		expect(vault.native()).toEqual([BPM, "a", "b"].sort());

		expect(vault.plugins.log.filter((entry) => entry !== "save").length).toBe(logBefore);
		expect(vault.plugins.loaded()).toEqual([BPM, "a", "b"].sort());
	});

	test("turning staged startup off starts plugins still waiting for their turn", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await vault.launch();
		vault.record("a").startupTier = "background";
		await vault.startup.setStagedStartup(true);
		await vault.launch();
		expect(vault.startup.pendingStarts()).toEqual(["a"]);
		await vault.startup.setStagedStartup(false);
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
		expect(vault.startup.pendingStarts()).toEqual([]);
	});

	test("a plugin found on the native list at launch is taken over silently", async () => {
		const vault = new Vault(["a", "b"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a"]; // e.g. enabled natively while BPM was disabled
		await vault.launch();
		expect(vault.startup.isWanted("a")).toBe(true);
		expect(vault.native()).toEqual([BPM]);
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort()); // already running; not restarted
	});

	test("disabling BPM hands wanted plugins back to Obsidian and starts pending ones", async () => {
		const vault = new Vault(["a", "b", "off"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a", "b"];
		await vault.launch();
		vault.record("b").startupTier = "background";
		await vault.startup.setStagedStartup(true);
		await vault.launch();
		await settle();
		expect(vault.startup.pendingStarts()).toEqual(["b"]);

		vault.startup.stop();
		await settle();
		expect(vault.native()).toEqual([BPM, "a", "b"].sort());
		expect(vault.plugins.loaded()).toEqual([BPM, "a", "b"].sort());
	});
});

describe("native toggles (Obsidian's own settings / CLI)", () => {
	test("are adopted as the user's intent", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();

		await vault.plugins.enablePluginAndSave("a");
		await settle();
		expect(vault.startup.isWanted("a")).toBe(true);

		await vault.plugins.disablePluginAndSave("a");
		await settle();
		expect(vault.startup.isWanted("a")).toBe(false);
	});

	test("with staged startup, switching off a BPM-started plugin natively (it's only unloaded) is adopted", async () => {
		// Obsidian's toggle shows running state, so a BPM-started plugin shows "on"; turning it off there calls
		// disablePluginAndSave, which can't change the native list (the plugin isn't on it) and just unloads it.
		const vault = new Vault(["a"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await vault.launch();
		await vault.launch();
		await settle();
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());

		await vault.plugins.disablePluginAndSave("a");
		await settle();
		expect(vault.startup.isWanted("a")).toBe(false);
		await vault.launch();
		await advance(10_000);
		expect(vault.plugins.loaded()).toEqual([BPM]);
	});

	test("a native enable with staged startup is handed back to BPM without stopping the plugin", async () => {
		const vault = new Vault(["a"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();
		await vault.plugins.enablePluginAndSave("a");
		await settle();
		await settle();
		expect(vault.startup.isWanted("a")).toBe(true);
		expect(vault.native()).toEqual([BPM]);
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
		// ...and switching it off again is still noticed.
		await vault.plugins.disablePluginAndSave("a");
		await settle();
		expect(vault.startup.isWanted("a")).toBe(false);
	});

	test("BPM's own loads, unloads and reloads aren't mistaken for native toggles", async () => {
		const vault = new Vault(["a", "b", "c"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "c"];
		await vault.launch();
		await vault.startup.restart("c");
		await vault.startup.whileUnloaded("c", async () => { await settle(); });
		await settle();
		expect(vault.startup.isWanted("c")).toBe(true);
	});

	test("BPM's own changes aren't mistaken for native toggles", async () => {
		const vault = new Vault(["a", "b"]);
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();
		await vault.startup.setWantedMany({ a: true, b: true });
		await settle();
		await vault.startup.setWanted("b", false);
		await settle();
		expect(vault.startup.isWanted("a")).toBe(true);
		expect(vault.startup.isWanted("b")).toBe(false);
	});
});

describe("bpm-ignore", () => {
	test("ignored plugins follow the native list, and setWanted edits it directly", async () => {
		const vault = new Vault(["x"]);
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();
		await vault.startup.setIgnored("x", true);
		expect(vault.startup.isWanted("x")).toBe(false);

		await vault.startup.setWanted("x", true);
		expect(vault.native()).toEqual([BPM, "x"].sort());
		await vault.launch();
		expect(vault.plugins.loaded()).toEqual([BPM, "x"].sort()); // started by Obsidian, not BPM
		expect(vault.startup.pendingStarts()).toEqual([]);
	});

	test("adding or removing the tag anywhere is picked up by reconcile()", async () => {
		const vault = new Vault(["x"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "x"];
		await vault.launch(); // x adopted as wanted, moved under BPM
		expect(vault.native()).toEqual([BPM]);

		vault.record("x").tags.push(BPM_IGNORE_TAG); // e.g. the tags modal
		await vault.startup.reconcile();
		expect(vault.native()).toEqual([BPM, "x"].sort());

		vault.record("x").tags = [];
		await vault.startup.reconcile();
		expect(vault.native()).toEqual([BPM]);
		expect(vault.startup.isWanted("x")).toBe(true);
	});

	test("un-ignoring takes the plugin back under BPM with its native state", async () => {
		const vault = new Vault(["x"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "x"];
		vault.settings.Plugins.push({ id: "x", name: "x", desc: "", group: "", tags: [BPM_IGNORE_TAG], enabled: false, startupTier: "after-ready", note: "" });
		await vault.launch();
		await vault.startup.setIgnored("x", false);
		expect(vault.startup.isWanted("x")).toBe(true);
		expect(vault.native()).toEqual([BPM]);
	});
});

describe("installs and updates", () => {
	test("a fresh install is loaded and wanted (old installer order left it unloaded)", async () => {
		const vault = new Vault([]);
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();
		vault.plugins.install("new"); // files written; Obsidian doesn't know yet
		expect(await vault.startup.applyInstalledFiles("new")).toBe(true);
		expect(vault.plugins.loaded()).toEqual([BPM, "new"].sort());
		expect(vault.native()).toEqual([BPM, "new"].sort());
		expect(vault.plugins.plugins.new.userEnabled).toBe(true);
	});

	test("updating a disabled plugin keeps it disabled", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();
		expect(await vault.startup.applyInstalledFiles("a")).toBe(true);
		expect(vault.plugins.loaded()).toEqual([BPM].sort());
		expect(vault.startup.isWanted("a")).toBe(false);
	});

	test("updating a running plugin reloads it", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await vault.launch();
		vault.plugins.log = [];
		await vault.startup.applyInstalledFiles("a");
		expect(vault.plugins.log.filter((entry) => entry !== "save")).toEqual(["unload:a", "load:a"]);
	});

	test("with staged startup, an update doesn't put the plugin on the native list", async () => {
		const vault = new Vault(["a"]);
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM];
		vault.settings.Plugins.push({ id: "a", name: "a", desc: "", group: "", tags: [], enabled: true, startupTier: "after-ready", note: "" });
		await vault.launch();
		await settle();
		await vault.startup.applyInstalledFiles("a");
		expect(vault.native()).toEqual([BPM]);
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
	});
});

describe("single start and restart", () => {
	test("startOnce runs a plugin without making it wanted", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();
		await vault.startup.startOnce("a");
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
		expect(vault.startup.isWanted("a")).toBe(false);
		expect(vault.native()).toEqual([BPM]);
	});

	test("restart reloads without touching the native list, in either mode", async () => {
		for (const staged of [false, true]) {
			const vault = new Vault(["a"], { newRecordTier: "after-ready" });
			vault.settings.STAGED_STARTUP = staged;
			vault.plugins.communityPluginsOnDisk = [BPM, "a"];
			await vault.launch();
			await settle();
			const native = vault.native();
			vault.plugins.log = [];
			expect(await vault.startup.restart("a")).toBe(true);
			expect(vault.plugins.log).toEqual(["unload:a", "load:a"]);
			expect(vault.native()).toEqual(native);
		}
	});
});

describe("external settings changes (data.json changed on disk, e.g. by Sync)", () => {
	test("reach BPM-started plugins exactly once, and native ones only via Obsidian", async () => {
		const vault = new Vault(["native", "delayed"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "native", "delayed"];
		await vault.launch();
		await vault.startup.setIgnored("native", true);
		await vault.launch();
		await settle();
		expect(vault.plugins.loaded()).toEqual([BPM, "delayed", "native"].sort());

		vault.plugins.emitRaw(".obsidian/plugins/native/data.json");
		vault.plugins.emitRaw(".obsidian/plugins/delayed/data.json");
		expect(vault.plugins.plugins.native.configFileChanges).toBe(1); // Obsidian's own forwarding, not doubled
		expect(vault.plugins.plugins.delayed.configFileChanges).toBe(1); // BPM's forwarding
	});

	test("ignore other files, and plugins that aren't running", async () => {
		const vault = new Vault(["a", "off"]);
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await vault.launch();
		await vault.launch();
		await settle();
		vault.plugins.emitRaw(".obsidian/plugins/a/main.js");
		vault.plugins.emitRaw(".obsidian/plugins/a/sub/data.json");
		vault.plugins.emitRaw(".obsidian/plugins/off/data.json");
		vault.plugins.emitRaw("notes/data.json");
		expect(vault.plugins.plugins.a.configFileChanges).toBe(0);
	});

	test("stop forwarding once BPM is unloaded", async () => {
		const vault = new Vault(["a"]);
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await vault.launch();
		await vault.launch();
		await settle();
		vault.startup.stop();
		vault.plugins.enabledPlugins.delete("a"); // isolate BPM's forwarding from Obsidian's
		vault.plugins.emitRaw(".obsidian/plugins/a/data.json");
		expect(vault.plugins.plugins.a.configFileChanges).toBe(0);
	});
});

describe("setStartupTier", () => {
	test("moves plugins on or off the native list (next launch), skipping ignored ones and BPM", async () => {
		const vault = new Vault(["a", "b", "ignored"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a", "b", "ignored"];
		await vault.launch();
		await vault.startup.setIgnored("ignored", true);
		expect(vault.native()).toEqual([BPM, "ignored"].sort());
		const logBefore = vault.plugins.log.filter((entry) => entry !== "save").length;

		expect(await vault.startup.setStartupTier(["a", "ignored", BPM], "native")).toEqual(["a"]);
		expect(vault.native()).toEqual([BPM, "a", "ignored"].sort());
		expect(vault.record("a").startupTier).toBe("native");
		expect(await vault.startup.setStartupTier(["a", "b"], "background")).toEqual(["a", "b"]);
		expect(vault.native()).toEqual([BPM, "ignored"].sort());
		expect(vault.plugins.log.filter((entry) => entry !== "save").length).toBe(logBefore); // nothing reloaded
	});

	test("outside staged startup it only records the tier", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await vault.launch();
		await vault.startup.setStartupTier(["a"], "background");
		expect(vault.native()).toEqual([BPM, "a"].sort());
		await vault.startup.setStagedStartup(true);
		expect(vault.native()).toEqual([BPM]);
	});
});

describe("unloads BPM didn't cause and the user didn't make (reloads, updates)", () => {
	/** Real loads read main.js before the plugin shows up, so Obsidian's 0 ms "changed" fires in between. */
	const realisticVault = (ids: string[], options?: { newRecordTier?: StartupTier }) => {
		const vault = new Vault(ids, options);
		vault.plugins.loadDelayMs = 5;
		return vault;
	};
	/** Await something that waits on the fake clock (a load's main.js read). */
	const run = async <T>(promise: Promise<T>): Promise<T> => {
		await advance(50);
		return promise;
	};

	test("BPM's own restart keeps the plugin wanted and on the native list", async () => {
		const vault = realisticVault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await run(vault.launch());
		expect(await run(vault.startup.restart("a"))).toBe(true);
		await settle();
		expect(vault.startup.isWanted("a")).toBe(true);
		expect(vault.native()).toEqual([BPM, "a"].sort());
	});

	test("updating a running plugin keeps it wanted", async () => {
		const vault = realisticVault(["a"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await run(vault.launch());
		await run(vault.startup.applyInstalledFiles("a"));
		await settle();
		expect(vault.startup.isWanted("a")).toBe(true);
	});

	test("Obsidian's own updater (disablePlugin, then enablePlugin(id, true)) isn't taken as switching it off", async () => {
		const vault = realisticVault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await run(vault.launch());
		await vault.plugins.disablePlugin("a");
		await run(vault.plugins.enablePlugin("a", true));
		await settle();
		expect(vault.startup.isWanted("a")).toBe(true);
		expect(vault.native()).toEqual([BPM, "a"].sort());
	});

	test("Obsidian's own toggle switching off a BPM-started plugin is still adopted", async () => {
		const vault = realisticVault(["a"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await run(vault.launch());
		await run(vault.launch());
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
		await vault.plugins.disablePluginAndSave("a");
		await settle();
		expect(vault.startup.isWanted("a")).toBe(false);
	});

	test("a plugin is never loaded twice by overlapping starts", async () => {
		const vault = realisticVault(["a", "b"], { newRecordTier: "after-ready" });
		vault.settings.STAGED_STARTUP = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "a", "b"];
		await run(vault.launch());
		await run(vault.launch({ untilLayoutReady: false }));
		vault.plugins.log = [];
		vault.finishLayout();
		await vi.advanceTimersToNextTimerAsync(); // the staged start of a is now reading main.js
		const started = vault.startup.startOnce("a");
		const off = vault.startup.setStagedStartup(false); // starts what's pending, i.e. b
		await advance(100);
		await started;
		await off;
		expect(vault.plugins.log.filter((entry) => entry.startsWith("load:"))).toEqual(["load:a", "load:b"]);
	});
});
