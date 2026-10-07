import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PluginStartup } from "../src/plugin-startup";
import type { PluginStartupHost, PluginStartupRegistry } from "../src/plugin-startup";
import type { ManagerPlugin } from "../src/data/types";
import { BPM_IGNORE_TAG } from "../src/data/types";
import { FakePluginManager } from "./support/fake-plugin-manager";

const BPM = "better-plugins-manager";

/** A vault: Obsidian's plugin manager plus BPM's settings, which survive "restarts" like data.json does. */
class Vault {
	plugins = new FakePluginManager();
	settings = { DELAY: false, DELAYS: [{ id: "soon", name: "Soon", time: 0.5 }, { id: "later", name: "Later", time: 5 }], Plugins: [] as ManagerPlugin[] };
	saves = 0;
	startup!: PluginStartup;

	constructor(ids: string[]) {
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
			saveSettings: async () => { this.saves++; },
			createRecord: (id, wanted) => {
				const record: ManagerPlugin = { id, name: id, desc: "", group: "", tags: [], enabled: wanted, delay: "", note: "" };
				this.settings.Plugins.push(record);
				return record;
			},
		};
	}

	/** Launch Obsidian (reads community-plugins.json, starts what's listed), then BPM's onload. */
	async launch(): Promise<void> {
		await this.plugins.startup();
		this.startup = new PluginStartup(this.host());
		await this.startup.start();
	}

	native(): string[] {
		return [...this.plugins.communityPluginsOnDisk].sort();
	}
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("normal mode", () => {
	test("startup adopts the native startup list as what's wanted", async () => {
		const vault = new Vault(["a", "b"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		vault.settings.Plugins.push({ id: "b", name: "b", desc: "", group: "", tags: [], enabled: true, delay: "", note: "" });
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

describe("delay mode", () => {
	test("Obsidian starts only BPM and ignored plugins; BPM starts the rest after their delays", async () => {
		const vault = new Vault(["fast", "slow", "native", "off"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "fast", "slow", "native"];
		await vault.launch();
		vault.record("fast").delay = "soon";
		vault.record("slow").delay = "later";
		await vault.startup.setIgnored("native", true);
		await vault.startup.setDelayMode(true);

		await vault.launch();
		expect(vault.native()).toEqual([BPM, "native"].sort());
		expect(vault.plugins.loaded()).toEqual([BPM, "native"].sort());
		await advance(499);
		expect(vault.plugins.loaded()).toEqual([BPM, "native"].sort());
		await advance(1);
		expect(vault.plugins.loaded()).toEqual([BPM, "fast", "native"].sort());
		await advance(4500);
		expect(vault.plugins.loaded()).toEqual([BPM, "fast", "native", "slow"].sort());
		expect(vault.plugins.loaded()).not.toContain("off");
	});

	test("delay starts aren't user-initiated (no onUserEnable)", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		vault.settings.DELAY = true;
		await vault.launch(); // a was on the native list: adopted, moved under BPM from the next launch
		await vault.launch();
		await advance(0);
		expect(vault.plugins.plugins.a?.userEnabled).toBe(false);
	});

	test("switching delay mode never reloads anything", async () => {
		const vault = new Vault(["a", "b"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a", "b"];
		await vault.launch();
		const logBefore = vault.plugins.log.filter((entry) => entry !== "save").length;

		await vault.startup.setDelayMode(true);
		expect(vault.native()).toEqual([BPM]);
		await vault.startup.setDelayMode(false);
		expect(vault.native()).toEqual([BPM, "a", "b"].sort());

		expect(vault.plugins.log.filter((entry) => entry !== "save").length).toBe(logBefore);
		expect(vault.plugins.loaded()).toEqual([BPM, "a", "b"].sort());
	});

	test("turning delay mode off starts plugins still waiting on their delay", async () => {
		const vault = new Vault(["a"]);
		vault.plugins.communityPluginsOnDisk = [BPM, "a"];
		await vault.launch();
		vault.record("a").delay = "later";
		await vault.startup.setDelayMode(true);
		await vault.launch();
		expect(vault.startup.pendingStarts()).toEqual(["a"]);
		await vault.startup.setDelayMode(false);
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
		expect(vault.startup.pendingStarts()).toEqual([]);
	});

	test("a plugin found on the native list at launch is taken over silently", async () => {
		const vault = new Vault(["a", "b"]);
		vault.settings.DELAY = true;
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
		vault.record("b").delay = "later";
		await vault.startup.setDelayMode(true);
		await vault.launch();
		await advance(0);
		expect(vault.startup.pendingStarts()).toEqual(["b"]);

		vault.startup.stop();
		await advance(0);
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
		await advance(0);
		expect(vault.startup.isWanted("a")).toBe(true);

		await vault.plugins.disablePluginAndSave("a");
		await advance(0);
		expect(vault.startup.isWanted("a")).toBe(false);
	});

	test("in delay mode, a natively enabled plugin stays native this session and moves under BPM next launch", async () => {
		const vault = new Vault(["a"]);
		vault.settings.DELAY = true;
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();

		await vault.plugins.enablePluginAndSave("a");
		await advance(0);
		expect(vault.startup.isWanted("a")).toBe(true);
		expect(vault.native()).toEqual([BPM, "a"].sort());

		await vault.launch();
		expect(vault.native()).toEqual([BPM]);
		await advance(0);
		expect(vault.plugins.loaded()).toEqual([BPM, "a"].sort());
	});

	test("BPM's own changes aren't mistaken for native toggles", async () => {
		const vault = new Vault(["a", "b"]);
		vault.plugins.communityPluginsOnDisk = [BPM];
		await vault.launch();
		await vault.startup.setWantedMany({ a: true, b: true });
		await advance(0);
		await vault.startup.setWanted("b", false);
		await advance(0);
		expect(vault.startup.isWanted("a")).toBe(true);
		expect(vault.startup.isWanted("b")).toBe(false);
	});
});

describe("bpm-ignore", () => {
	test("ignored plugins follow the native list, and setWanted edits it directly", async () => {
		const vault = new Vault(["x"]);
		vault.settings.DELAY = true;
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

	test("un-ignoring takes the plugin back under BPM with its native state", async () => {
		const vault = new Vault(["x"]);
		vault.settings.DELAY = true;
		vault.plugins.communityPluginsOnDisk = [BPM, "x"];
		vault.settings.Plugins.push({ id: "x", name: "x", desc: "", group: "", tags: [BPM_IGNORE_TAG], enabled: false, delay: "", note: "" });
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

	test("in delay mode, an update doesn't put the plugin on the native list", async () => {
		const vault = new Vault(["a"]);
		vault.settings.DELAY = true;
		vault.plugins.communityPluginsOnDisk = [BPM];
		vault.settings.Plugins.push({ id: "a", name: "a", desc: "", group: "", tags: [], enabled: true, delay: "", note: "" });
		await vault.launch();
		await advance(0);
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
		for (const delay of [false, true]) {
			const vault = new Vault(["a"]);
			vault.settings.DELAY = delay;
			vault.plugins.communityPluginsOnDisk = [BPM, "a"];
			await vault.launch();
			await advance(0);
			const native = vault.native();
			vault.plugins.log = [];
			expect(await vault.startup.restart("a")).toBe(true);
			expect(vault.plugins.log).toEqual(["unload:a", "load:a"]);
			expect(vault.native()).toEqual(native);
		}
	});
});
