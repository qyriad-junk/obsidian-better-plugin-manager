import { describe, expect, test } from "vitest";
import type Manager from "main";
import { DELAY_SETTINGS_BACKUP_FILE, migrateDelaysToStartupTiers } from "../src/migrations";

const FOLDER = ".obsidian/plugins/better-plugins-manager";
const BACKUP = `${FOLDER}/${DELAY_SETTINGS_BACKUP_FILE}`;

/** Enough of Manager for the migration: its manifest and an in-memory vault adapter holding data.json. */
function fakeManager(dataJson: string | null, { failWrites = false } = {}) {
	const files = new Map<string, string>();
	if (dataJson !== null) files.set(`${FOLDER}/data.json`, dataJson);
	const manager = {
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
	};
	return { manager: manager as unknown as Manager, files };
}

const LEGACY = JSON.stringify({
	DELAY: true,
	DELAYS: [{ id: "default", name: "Default", time: 1 }],
	Plugins: [{ id: "a", enabled: true, delay: "default" }],
}, null, "\t");

describe("migrateDelaysToStartupTiers", () => {
	test("backs up data.json byte for byte, then converts the loaded data", async () => {
		const { manager, files } = fakeManager(LEGACY);
		const data = JSON.parse(LEGACY);
		expect(await migrateDelaysToStartupTiers(manager, data)).toEqual({ status: "converted", backupPath: BACKUP });
		expect(files.get(BACKUP)).toBe(LEGACY);
		expect(data.STAGED_STARTUP).toBe(true);
		expect(data.Plugins[0]).toEqual({ id: "a", enabled: true, startupTier: "after-ready" });
		expect(data).not.toHaveProperty("DELAYS");
	});

	test("does nothing once converted", async () => {
		const { manager, files } = fakeManager(LEGACY);
		const data = JSON.parse(LEGACY);
		await migrateDelaysToStartupTiers(manager, data);
		const after = JSON.stringify(data);
		expect(await migrateDelaysToStartupTiers(manager, data)).toBeNull();
		expect(JSON.stringify(data)).toBe(after);
		expect(files.size).toBe(2);
	});

	test("never overwrites an existing backup (keeps the earliest settings)", async () => {
		const { manager, files } = fakeManager(LEGACY);
		files.set(BACKUP, "earlier");
		await migrateDelaysToStartupTiers(manager, JSON.parse(LEGACY));
		expect(files.get(BACKUP)).toBe("earlier");
	});

	test("without data.json, backs up the loaded data itself", async () => {
		const { manager, files } = fakeManager(null);
		const data = JSON.parse(LEGACY);
		await migrateDelaysToStartupTiers(manager, data);
		expect(JSON.parse(files.get(BACKUP)!)).toEqual(JSON.parse(LEGACY));
	});

	test("if the backup can't be written: works as converted, but keeps the old fields (nothing lost)", async () => {
		const { manager } = fakeManager(LEGACY, { failWrites: true });
		const data = JSON.parse(LEGACY);
		const original = console.error;
		console.error = () => {};
		try {
			expect(await migrateDelaysToStartupTiers(manager, data)).toMatchObject({ status: "backup-failed" });
		} finally {
			console.error = original;
		}
		// Staged startup stays on, so delay-mode plugins (not on Obsidian's list) aren't taken as switched off.
		expect(data.STAGED_STARTUP).toBe(true);
		expect(data.Plugins[0]).toEqual({ id: "a", enabled: true, delay: "default", startupTier: "after-ready" });
		expect(data.DELAYS).toEqual(JSON.parse(LEGACY).DELAYS);
		// ...and the next load, with a backup, finishes the job with the same result.
		const retry = fakeManager(JSON.stringify(data));
		await migrateDelaysToStartupTiers(retry.manager, data);
		expect(data.Plugins[0]).toEqual({ id: "a", enabled: true, startupTier: "after-ready" });
		expect(data).not.toHaveProperty("DELAY");
	});

	test("a saved STAGED_STARTUP wins over a stale DELAY (written back by an older BPM elsewhere)", async () => {
		const stale = JSON.stringify({ DELAY: false, STAGED_STARTUP: true, Plugins: [{ id: "a", enabled: true, startupTier: "background", delay: "" }] });
		const { manager } = fakeManager(stale);
		const data = JSON.parse(stale);
		await migrateDelaysToStartupTiers(manager, data);
		expect(data.STAGED_STARTUP).toBe(true);
		expect(data.Plugins[0].startupTier).toBe("background");
	});
});
