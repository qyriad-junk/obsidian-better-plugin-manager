import { describe, expect, test } from "vitest";
import type Manager from "main";
import { DELAY_SETTINGS_BACKUP_FILE, migrateDelaysToStartupTiers } from "../src/migrations";

const FOLDER = ".obsidian/plugins/better-plugins-manager";

/** Enough of Manager for the migration: settings, saveData, and an in-memory vault adapter. */
function fakeManager(dataJson: string | null, { failWrites = false } = {}) {
	const files = new Map<string, string>();
	if (dataJson !== null) files.set(`${FOLDER}/data.json`, dataJson);
	const manager = {
		settings: dataJson ? { STAGED_STARTUP: false, ...JSON.parse(dataJson) } : {},
		manifest: { id: "better-plugins-manager", dir: FOLDER },
		app: {
			vault: {
				configDir: ".obsidian",
				adapter: {
					exists: async (path: string) => files.has(path),
					read: async (path: string) => {
						const content = files.get(path);
						if (content === undefined) throw new Error(`ENOENT ${path}`);
						return content;
					},
					write: async (path: string, content: string) => {
						if (failWrites) throw new Error("EACCES");
						files.set(path, content);
					},
				},
			},
		},
		saveData: async (data: unknown) => { files.set(`${FOLDER}/data.json`, JSON.stringify(data)); },
	};
	return { manager: manager as unknown as Manager & { settings: Record<string, unknown> }, files };
}

const LEGACY = JSON.stringify({
	DELAY: true,
	DELAYS: [{ id: "default", name: "Default", time: 1 }],
	Plugins: [{ id: "a", enabled: true, delay: "default" }],
}, null, "\t");

describe("migrateDelaysToStartupTiers", () => {
	test("backs up data.json byte for byte, then converts and saves", async () => {
		const { manager, files } = fakeManager(LEGACY);
		const backup = await migrateDelaysToStartupTiers(manager);
		expect(backup).toBe(`${FOLDER}/${DELAY_SETTINGS_BACKUP_FILE}`);
		expect(files.get(backup!)).toBe(LEGACY);
		const saved = JSON.parse(files.get(`${FOLDER}/data.json`)!);
		expect(saved.STAGED_STARTUP).toBe(true);
		expect(saved.Plugins[0]).toEqual({ id: "a", enabled: true, startupTier: "after-ready" });
		expect(saved).not.toHaveProperty("DELAYS");
	});

	test("does nothing once converted", async () => {
		const { manager, files } = fakeManager(LEGACY);
		await migrateDelaysToStartupTiers(manager);
		const after = new Map(files);
		expect(await migrateDelaysToStartupTiers(manager)).toBeNull();
		expect(files).toEqual(after);
	});

	test("never overwrites an existing backup (keeps the earliest settings)", async () => {
		const { manager, files } = fakeManager(LEGACY);
		files.set(`${FOLDER}/${DELAY_SETTINGS_BACKUP_FILE}`, "earlier");
		await migrateDelaysToStartupTiers(manager);
		expect(files.get(`${FOLDER}/${DELAY_SETTINGS_BACKUP_FILE}`)).toBe("earlier");
	});

	test("converts nothing if the backup can't be written", async () => {
		const { manager } = fakeManager(LEGACY, { failWrites: true });
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		try {
			expect(await migrateDelaysToStartupTiers(manager)).toBeNull();
		} finally {
			console.error = original;
		}
		expect(errors).toHaveLength(1);
		expect(manager.settings.DELAY).toBe(true);
		expect(manager.settings.Plugins).toEqual([{ id: "a", enabled: true, delay: "default" }]);
	});
});
