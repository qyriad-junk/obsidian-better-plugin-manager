/**
 * Runtime stand-in for the "obsidian" module in unit tests (see vitest.config.ts).
 *
 * Only what modules under test actually *call* at runtime belongs here; type-only imports are erased.
 * Keep each stub minimal and obviously fake. Behaviour worth testing goes in fakes, not here.
 */

/** Tests run "on" this Obsidian API version unless they override it. */
export let stubApiVersion = "1.13.7";
export const setStubApiVersion = (version: string) => { stubApiVersion = version; };

export const requireApiVersion = (version: string): boolean => {
	const parse = (v: string) => v.split(".").map((part) => Number(part) || 0);
	const [want, have] = [parse(version), parse(stubApiVersion)];
	for (let i = 0; i < Math.max(want.length, have.length); i++) {
		if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
	}
	return true;
};

export const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");

export class Notice {
	static shown: string[] = [];
	constructor(message: string) { Notice.shown.push(message); }
	setMessage() { return this; }
	hide() { /* no-op */ }
}

export class Events {
	private handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	on(name: string, callback: (...args: unknown[]) => unknown) {
		const list = this.handlers.get(name) ?? [];
		list.push(callback);
		this.handlers.set(name, list);
		return { name, callback };
	}
	offref(ref: { name: string; callback: (...args: unknown[]) => unknown }) {
		this.handlers.set(ref.name, (this.handlers.get(ref.name) ?? []).filter((cb) => cb !== ref.callback));
	}
	trigger(name: string, ...args: unknown[]) {
		for (const callback of this.handlers.get(name) ?? []) callback(...args);
	}
}
