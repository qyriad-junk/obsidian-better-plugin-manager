/**
 * When a plugin BPM manages starts, in staged-startup mode. What matters is whether a plugin holds up the workspace
 * becoming usable, not a number of seconds, so these are ordered stages rather than delays:
 *
 * - `native`: Obsidian starts it itself, during its own startup, before the workspace is ready (blocks it).
 * - `after-ready`: BPM starts it as soon as the workspace is ready, one plugin at a time.
 * - `background`: BPM starts it after every `after-ready` plugin, one at a time, whenever Obsidian is idle.
 *
 * Outside staged-startup mode every wanted plugin is started natively, whatever its tier.
 */
export type StartupTier = (typeof STARTUP_TIERS)[number];

/** Every startup tier, in start order. */
export const STARTUP_TIERS = ["native", "after-ready", "background"] as const;

/** What Obsidian itself would do. */
export const DEFAULT_STARTUP_TIER: StartupTier = "native";

export function isStartupTier(value: unknown): value is StartupTier {
	return typeof value === "string" && (STARTUP_TIERS as readonly string[]).includes(value);
}

/**
 * Delays at or above this many seconds were meant as "whenever"; shorter ones as "just not during startup".
 * (Agreed mapping for BPM's old per-plugin delays.)
 */
export const LEGACY_BACKGROUND_DELAY_SECONDS = 5;

/** The tier for a plugin that had an old-style start delay of `seconds` (0 or none: started with Obsidian). */
export function tierForLegacyDelay(seconds: number | undefined): StartupTier {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "native";
	return seconds >= LEGACY_BACKGROUND_DELAY_SECONDS ? "background" : "after-ready";
}

/** A delay preset from before startup tiers (`settings.DELAYS`), as found in old data; `time` is unchecked. */
export interface LegacyDelayPreset {
	id: string;
	name?: string;
	time?: unknown;
}

/** The tier for a plugin record whose old `delay` field named one of `presets` ("" or unknown: no delay). */
export function tierForLegacyDelayPreset(delayId: string | undefined, presets: readonly LegacyDelayPreset[] | undefined): StartupTier {
	const time = presets?.find((preset) => preset.id === delayId)?.time;
	return tierForLegacyDelay(typeof time === "number" ? time : undefined);
}

/** The settings keys that startup tiers replaced. */
const LEGACY_DELAY_KEYS = ["DELAY", "DELAYS", "FILTER_DELAY", "FILTER_DELAY_VALUES", "FILTER_DELAY_OPERATOR"] as const;

type LooseSettings = Record<string, unknown> & { Plugins?: unknown };

function legacyRecords(settings: LooseSettings): Record<string, unknown>[] {
	return Array.isArray(settings.Plugins)
		? settings.Plugins.filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === "object")
		: [];
}

/** Whether BPM's settings (as loaded from data.json) still use per-plugin delay presets. */
export function hasLegacyDelaySettings(settings: LooseSettings): boolean {
	return LEGACY_DELAY_KEYS.some((key) => key in settings) || legacyRecords(settings).some((record) => "delay" in record);
}

/**
 * Convert BPM's saved settings (data.json as loaded, before defaults are filled in) from delay presets to startup
 * tiers, in place: each record's `delay` (a preset id) becomes a `startupTier` via {@link tierForLegacyDelayPreset},
 * and `DELAY` becomes `STAGED_STARTUP` unless that was saved too (an older BPM on another device writes its own
 * `DELAY: false` back next to it). Records that already have a tier keep it.
 *
 * The old fields are then dropped, unless `keepLegacyFields` (no backup yet): the settings work as converted, and
 * converting again later gives the same result. Returns whether there was anything to convert.
 */
export function migrateLegacyDelaySettings(settings: LooseSettings, { keepLegacyFields = false } = {}): boolean {
	if (!hasLegacyDelaySettings(settings)) return false;
	const presets = Array.isArray(settings.DELAYS)
		? settings.DELAYS.filter((preset): preset is LegacyDelayPreset => Boolean(preset) && typeof preset === "object"
			&& typeof (preset as LegacyDelayPreset).id === "string")
		: [];
	if ("DELAY" in settings && !("STAGED_STARTUP" in settings)) settings.STAGED_STARTUP = Boolean(settings.DELAY);
	for (const record of legacyRecords(settings)) {
		if (!isStartupTier(record.startupTier)) {
			record.startupTier = tierForLegacyDelayPreset(typeof record.delay === "string" ? record.delay : undefined, presets);
		}
		if (!keepLegacyFields) delete record.delay;
	}
	if (!keepLegacyFields) for (const key of LEGACY_DELAY_KEYS) delete settings[key];
	return true;
}

/** Give every record a valid startup tier (hand-edited or otherwise odd data.json): the default where it has none. */
export function normalizeStartupTiers(records: readonly { startupTier?: unknown }[]): boolean {
	let changed = false;
	for (const record of records) {
		if (isStartupTier(record.startupTier)) continue;
		record.startupTier = DEFAULT_STARTUP_TIER;
		changed = true;
	}
	return changed;
}

/** Translation keys (src/lang) for each tier's name. */
export const STARTUP_TIER_LABEL_KEYS = {
	"native": "启动阶段_随Obsidian",
	"after-ready": "启动阶段_就绪后",
	"background": "启动阶段_后台",
} as const satisfies Record<StartupTier, string>;

/** Icons (Lucide) for each tier. */
export const STARTUP_TIER_ICONS = {
	"native": "zap",
	"after-ready": "timer",
	"background": "hourglass",
} as const satisfies Record<StartupTier, string>;
