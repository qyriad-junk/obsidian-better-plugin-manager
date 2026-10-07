// Code under test uses window.setTimeout (Obsidian's lint rule, for popout windows). Tests run in Node, where there's no
// window; aliasing it to globalThis keeps vi.useFakeTimers() in control of those timers.
(globalThis as { window?: unknown }).window ??= globalThis;
