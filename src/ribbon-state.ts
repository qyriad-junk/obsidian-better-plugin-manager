/**
 * Keeps the left ribbon's saved layout (which icons are hidden, and their order) for plugins that start late.
 *
 * Obsidian restores the ribbon once, while loading the workspace layout: `leftRibbon.load({ hiddenItems })` applies
 * the saved hidden flags and order to the items that *exist at that moment*. A plugin started after that (by BPM, or
 * any lazy loader) adds its icon as a fresh, visible item at the end, and the next layout save persists it that way.
 * (`serialize()` only covers existing items, so a save before the plugin starts drops its entry entirely.)
 *
 * So: remember the saved layout from before Obsidian could overwrite it, and around each late start, load the ribbon
 * again with the remembered layout merged with the live one.
 *
 * Verified against Obsidian 1.13.7; see docs/codebase-notes.md.
 */

/** `workspace.leftRibbon`: the parts used here. `hiddenItems` key order is the ribbon order. */
export interface RibbonLayoutTarget {
	serialize(): { hiddenItems: Record<string, boolean> };
	load(layout: { hiddenItems: Record<string, boolean> }): void;
}

export class RibbonLayoutKeeper {
	/** Every item's hidden flag as last known, in ribbon order: the saved layout, updated from the live ribbon. */
	private remembered: Record<string, boolean>;
	/** Items that were on the ribbon at the last sync. */
	private seen = new Set<string>();

	/** @param saved The `left-ribbon.hiddenItems` of the workspace file, read before Obsidian could rewrite it. */
	constructor(private readonly ribbon: () => RibbonLayoutTarget | null | undefined, saved: Record<string, boolean> | null | undefined) {
		this.remembered = { ...(saved ?? {}) };
	}

	/**
	 * Bring the ribbon and the remembered layout in line. An item that has appeared since the last sync gets its
	 * remembered layout (it's a late start, added visible at the end); for every other item the live ribbon wins, so
	 * in-session changes (the user hiding or moving an icon) are kept. Call before and after starting plugins late.
	 */
	sync(): void {
		const ribbon = this.ribbon();
		if (!ribbon) return;
		const live = ribbon.serialize().hiddenItems;
		const arrived = Object.keys(live).filter((id) => !this.seen.has(id) && id in this.remembered);
		this.remembered = mergeRibbonLayout(this.remembered, live, arrived);
		const desired = mergeRibbonLayout(live, this.remembered);
		if (!sameLayout(live, desired)) ribbon.load({ hiddenItems: desired });
		this.seen = new Set(Object.keys(ribbon.serialize().hiddenItems));
	}
}

/**
 * Combine two ribbon layouts. `preferred` decides the hidden flag and relative order of every item it has; items only
 * in `base` keep their place in `base`'s order. Positions in `base` held by items that `preferred` also has are filled
 * with those items in `preferred`'s order, and `preferred`-only items go at the end.
 *
 * `except` ids are left out of `preferred`: for those, `base` decides.
 */
export function mergeRibbonLayout(base: Record<string, boolean>, preferred: Record<string, boolean>, except: string[] = []): Record<string, boolean> {
	const skip = new Set(except);
	const takesPreferred = (id: string) => id in preferred && !skip.has(id);
	const preferredOrder = Object.keys(preferred).filter((id) => !skip.has(id));
	const merged: Record<string, boolean> = {};
	let next = 0;
	for (const id of Object.keys(base)) {
		if (takesPreferred(id)) {
			// Fill this slot with the next shared item in preferred's order.
			while (next < preferredOrder.length && (preferredOrder[next] in merged || !(preferredOrder[next] in base))) next++;
			if (next < preferredOrder.length) merged[preferredOrder[next]] = preferred[preferredOrder[next]];
			next++;
		} else {
			merged[id] = base[id];
		}
	}
	for (const id of preferredOrder) {
		if (!(id in merged)) merged[id] = preferred[id];
	}
	return merged;
}

function sameLayout(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	return aKeys.length === bKeys.length && aKeys.every((id, index) => id === bKeys[index] && a[id] === b[id]);
}
