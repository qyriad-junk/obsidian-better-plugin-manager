import { describe, expect, test } from "vitest";
import { hasLegacyDelaySettings, migrateLegacyDelaySettings, normalizeStartupTiers, tierForLegacyDelay } from "../src/startup-tiers";

describe("tierForLegacyDelay (the agreed mapping)", () => {
	test.each([
		[undefined, "native"],
		[0, "native"],
		[0.3, "after-ready"],
		[4.9, "after-ready"],
		[5, "background"],
		[100, "background"],
		[Number.NaN, "native"],
		[-1, "native"],
	])("%s s → %s", (seconds, tier) => {
		expect(tierForLegacyDelay(seconds)).toBe(tier);
	});
});

describe("migrateLegacyDelaySettings", () => {
	const legacy = () => ({
		DELAY: true,
		DELAYS: [{ id: "default", name: "Default", time: 10 }, { id: "quick", name: "Quick", time: 0.5 }, { id: "zero", name: "Zero", time: 0 }],
		FILTER_DELAY: "quick",
		FILTER_DELAY_VALUES: ["quick"],
		FILTER_DELAY_OPERATOR: "contains",
		PERSISTENCE: true,
		Plugins: [
			{ id: "none", enabled: true, delay: "" },
			{ id: "quick", enabled: true, delay: "quick" },
			{ id: "slow", enabled: false, delay: "default" },
			{ id: "zero", enabled: true, delay: "zero" },
			{ id: "gone", enabled: true, delay: "deleted-preset" },
		] as Record<string, unknown>[],
	});

	test("converts presets to tiers and delay mode to staged startup", () => {
		const settings: Record<string, unknown> & { Plugins: Record<string, unknown>[] } = legacy();
		expect(migrateLegacyDelaySettings(settings)).toBe(true);
		expect(settings.STAGED_STARTUP).toBe(true);
		expect(settings.Plugins.map((record) => [record.id, record.startupTier])).toEqual([
			["none", "native"], ["quick", "after-ready"], ["slow", "background"], ["zero", "native"], ["gone", "native"],
		]);
		expect(settings.Plugins.some((record) => "delay" in record)).toBe(false);
		for (const key of ["DELAY", "DELAYS", "FILTER_DELAY", "FILTER_DELAY_VALUES", "FILTER_DELAY_OPERATOR"]) {
			expect(settings).not.toHaveProperty(key);
		}
		expect(settings.PERSISTENCE).toBe(true);
	});

	test("is idempotent, and leaves converted settings alone", () => {
		const settings = legacy();
		migrateLegacyDelaySettings(settings);
		const once = JSON.stringify(settings);
		expect(hasLegacyDelaySettings(settings)).toBe(false);
		expect(migrateLegacyDelaySettings(settings)).toBe(false);
		expect(JSON.stringify(settings)).toBe(once);
	});

	test("a record that already has a tier keeps it (e.g. a stale delay field written back by an old copy)", () => {
		const settings = { Plugins: [{ id: "a", startupTier: "background", delay: "" }] as Record<string, unknown>[] };
		expect(migrateLegacyDelaySettings(settings)).toBe(true);
		expect(settings.Plugins[0]).toEqual({ id: "a", startupTier: "background" });
	});

	test("delay mode off stays off", () => {
		const settings: Record<string, unknown> = { ...legacy(), DELAY: false };
		migrateLegacyDelaySettings(settings);
		expect(settings.STAGED_STARTUP).toBe(false);
	});

	test("a saved STAGED_STARTUP isn't overridden by DELAY", () => {
		const settings: Record<string, unknown> = { ...legacy(), DELAY: false, STAGED_STARTUP: true };
		migrateLegacyDelaySettings(settings);
		expect(settings.STAGED_STARTUP).toBe(true);
	});

	test("normalizeStartupTiers gives records without a valid tier the default", () => {
		const records: { startupTier?: unknown }[] = [{}, { startupTier: "bogus" }, { startupTier: "background" }];
		expect(normalizeStartupTiers(records)).toBe(true);
		expect(records.map((record) => record.startupTier)).toEqual(["native", "native", "background"]);
		expect(normalizeStartupTiers(records)).toBe(false);
	});
});
