import { describe, expect, test } from "vitest";
import { TroubleshootAlgorithm } from "../src/troubleshoot/troubleshoot-algorithm";
import type { TroubleshootState } from "../src/troubleshoot/troubleshoot-state";
import { FakePluginManager } from "./support/fake-plugin-manager";
import type Manager from "../src/main";

const BPM = "better-plugins-manager";

type Culprit = { kind: "single"; a: string } | { kind: "pair"; a: string; b: string };

function setup(pluginCount: number) {
	const plugins = new FakePluginManager();
	const ids = Array.from({ length: pluginCount }, (_, i) => `p${i}`);
	for (const id of [BPM, ...ids]) plugins.install(id);
	plugins.communityPluginsOnDisk = [BPM, ...ids];
	const manager = {
		manifest: { id: BPM },
		settings: { DELAY: false, Plugins: [] },
		translator: { t: (key: string) => key },
		saveSettings: async () => undefined,
	} as unknown as Manager;
	const algorithm = new TroubleshootAlgorithm({ plugins } as never, manager);
	return { plugins, ids, algorithm };
}

/** The oracle: does "the problem" reproduce with the currently enabled plugins? */
const problemExists = (culprit: Culprit, enabled: Set<string>) =>
	culprit.kind === "single" ? enabled.has(culprit.a) : enabled.has(culprit.a) && enabled.has(culprit.b);

const describeCulprit = (culprit: Culprit) =>
	culprit.kind === "single" ? `single:${culprit.a}` : `pair:${[culprit.a, culprit.b].sort().join("+")}`;

/**
 * Answer honestly until the algorithm finishes. If `wrongAt` is set, give the wrong answer at that step, check
 * that undo restores both the enabled plugins and the algorithm state, then carry on honestly.
 */
async function diagnose(pluginCount: number, culprit: Culprit, wrongAt: number | null): Promise<string> {
	const { plugins, algorithm } = setup(pluginCount);
	await plugins.startup();
	const state: TroubleshootState = algorithm.initState();
	await algorithm.startTroubleshoot(state);

	for (let step = 0; step < 100; step++) {
		if (step === wrongAt) {
			const enabledBefore = [...plugins.enabledPlugins].sort();
			const algorithmBefore = JSON.stringify(state.algorithmState);
			const wrong = await algorithm.executeNextStep(state, !problemExists(culprit, plugins.enabledPlugins));
			if (wrong.type === "continue") {
				expect(await algorithm.undo(state)).toBe(true);
				expect([...plugins.enabledPlugins].sort()).toEqual(enabledBefore);
				expect(JSON.stringify(state.algorithmState)).toBe(algorithmBefore);
			} else {
				return "wrong answer ended the session"; // nothing to undo; not what this test is about
			}
		}
		const result = await algorithm.executeNextStep(state, problemExists(culprit, plugins.enabledPlugins));
		if (result.type === "single") return `single:${result.culprit}`;
		if (result.type === "pair") return `pair:${[result.culpritA, result.culpritB].sort().join("+")}`;
		if (result.type !== "continue") return result.type;
	}
	return "did not terminate";
}

function culpritsFor(pluginCount: number): Culprit[] {
	const ids = Array.from({ length: pluginCount }, (_, i) => `p${i}`);
	const culprits: Culprit[] = ids.map((a) => ({ kind: "single", a }));
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) culprits.push({ kind: "pair", a: ids[i], b: ids[j] });
	}
	return culprits;
}

describe("TroubleshootAlgorithm", () => {
	test.each([1, 2, 3, 4, 5, 7, 8, 11, 16])("finds every single culprit and conflicting pair among %i plugins", async (n) => {
		for (const culprit of culpritsFor(n)) {
			expect(await diagnose(n, culprit, null)).toBe(describeCulprit(culprit));
		}
	});

	test.each([0, 1, 2, 3, 5])("undo after a wrong answer at step %i fully rewinds the session", async (wrongAt) => {
		for (const n of [3, 6, 9]) {
			for (const culprit of culpritsFor(n)) {
				const outcome = await diagnose(n, culprit, wrongAt);
				if (outcome !== "wrong answer ended the session") expect(outcome).toBe(describeCulprit(culprit));
			}
		}
	});

	test("reports an error instead of looping when no plugins were enabled", async () => {
		const { plugins, algorithm } = setup(0);
		await plugins.startup();
		const state = algorithm.initState();
		await algorithm.startTroubleshoot(state);
		const result = await algorithm.executeNextStep(state, false);
		expect(result.type).toBe("error");
	});
});
