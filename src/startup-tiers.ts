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
export type StartupTier = "native" | "after-ready" | "background";

/** In start order. */
export const STARTUP_TIERS: readonly StartupTier[] = ["native", "after-ready", "background"];

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
