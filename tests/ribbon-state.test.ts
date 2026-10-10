import { describe, expect, test } from "vitest";
import { mergeRibbonLayout, RibbonLayoutKeeper } from "../src/ribbon-state";

/** Obsidian 1.13.7's leftRibbon, as far as layout goes (see docs/codebase-notes.md). */
class FakeRibbon {
	items: { id: string; hidden: boolean }[] = [];

	/** addRibbonItemButton for a new id: appended, visible. */
	add(id: string): void {
		if (!this.items.some((item) => item.id === id)) this.items.push({ id, hidden: false });
	}

	remove(id: string): void {
		this.items = this.items.filter((item) => item.id !== id);
	}

	/** Applies only to existing items; sorts by key order, and items missing from the keys sort first (-1). */
	load(layout: { hiddenItems: Record<string, boolean> }): void {
		const keys = Object.keys(layout.hiddenItems);
		for (const item of this.items) item.hidden = layout.hiddenItems[item.id] ?? false;
		this.items.sort((a, b) => keys.indexOf(a.id) - keys.indexOf(b.id));
	}

	serialize(): { hiddenItems: Record<string, boolean> } {
		return { hiddenItems: Object.fromEntries(this.items.map((item) => [item.id, item.hidden])) };
	}

	setHidden(id: string, hidden: boolean): void {
		const item = this.items.find((entry) => entry.id === id);
		if (item) item.hidden = hidden;
	}

	shown(): string[] {
		return this.items.filter((item) => !item.hidden).map((item) => item.id);
	}

	order(): string[] {
		return this.items.map((item) => item.id);
	}
}

/** The workspace file says: a, late:x (hidden), b, late:y (visible). Obsidian loads it while only a and b exist. */
function launch() {
	const saved = { "a": false, "late:x": true, "b": false, "late:y": false };
	const ribbon = new FakeRibbon();
	ribbon.add("a");
	ribbon.add("b");
	ribbon.load({ hiddenItems: saved });
	const keeper = new RibbonLayoutKeeper(() => ribbon, saved);
	return { ribbon, keeper };
}

describe("RibbonLayoutKeeper", () => {
	test("without it, a late plugin's hidden icon comes back (the bug)", () => {
		const { ribbon } = launch();
		ribbon.add("late:x");
		expect(ribbon.shown()).toContain("late:x");
	});

	test("a late plugin's icon gets its saved hidden flag and position back", () => {
		const { ribbon, keeper } = launch();
		keeper.sync();
		ribbon.add("late:x");
		ribbon.add("late:y");
		keeper.sync();
		expect(ribbon.shown()).toEqual(["a", "b", "late:y"]);
		expect(ribbon.order()).toEqual(["a", "late:x", "b", "late:y"]);
	});

	test("an icon added after the sync that followed its plugin's start is still restored at the next sync", () => {
		const { ribbon, keeper } = launch();
		keeper.sync();
		keeper.sync(); // the plugin started, but adds its icon later (e.g. from onLayoutReady)
		ribbon.add("late:x");
		keeper.sync(); // before the next plugin starts
		expect(ribbon.shown()).not.toContain("late:x");
	});

	test("in-session changes win over the saved layout", () => {
		const { ribbon, keeper } = launch();
		keeper.sync();
		ribbon.add("late:x");
		keeper.sync();
		ribbon.setHidden("late:x", false); // the user shows it again
		ribbon.setHidden("a", true);
		keeper.sync();
		ribbon.add("late:y");
		keeper.sync();
		expect(ribbon.shown()).toEqual(["late:x", "b", "late:y"]);
	});

	test("a plugin switched off and on again mid-session keeps its icon's in-session state", () => {
		const { ribbon, keeper } = launch();
		keeper.sync();
		ribbon.add("late:y");
		keeper.sync();
		ribbon.setHidden("late:y", true);
		keeper.sync();
		ribbon.remove("late:y");
		keeper.sync();
		ribbon.add("late:y");
		keeper.sync();
		expect(ribbon.shown()).not.toContain("late:y");
	});

	test("icons nobody has a layout for stay where Obsidian put them", () => {
		const { ribbon, keeper } = launch();
		keeper.sync();
		ribbon.add("new");
		ribbon.add("late:x");
		keeper.sync();
		expect(ribbon.order()).toEqual(["a", "late:x", "b", "new"]);
		expect(ribbon.shown()).toEqual(["a", "b", "new"]);
	});

	test("does nothing without a ribbon (mobile layouts without one, or before the workspace exists)", () => {
		const keeper = new RibbonLayoutKeeper(() => null, { a: true });
		expect(() => keeper.sync()).not.toThrow();
	});
});

describe("mergeRibbonLayout", () => {
	test("preferred decides flags and relative order of shared items; base-only items keep their slots", () => {
		const base = { a: false, x: true, b: false, c: false };
		const preferred = { c: true, a: false, new: false };
		expect(Object.entries(mergeRibbonLayout(base, preferred))).toEqual([
			["c", true], ["x", true], ["b", false], ["a", false], ["new", false],
		]);
	});

	test("except ids are decided by base", () => {
		expect(mergeRibbonLayout({ a: true, b: false }, { a: false, b: true }, ["a"])).toEqual({ a: true, b: true });
	});
});
