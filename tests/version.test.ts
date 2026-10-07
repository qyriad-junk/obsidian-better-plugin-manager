import { describe, expect, test } from "vitest";
import { compareVersions } from "../src/version";

describe("compareVersions", () => {
	// [a, b, expected sign of compareVersions(a, b)]
	const cases: Array<[string, string, -1 | 0 | 1]> = [
		["1.0.0", "1.0.0", 0],
		["v1.0.0", "1.0.0", 0],
		[" v2.3.4 ", "2.3.4", 0],
		["1.2", "1.2.0", 0],
		["1.10.0", "1.9.0", 1],
		["2.0.0", "1.99.99", 1],
		["1.2.3.4", "1.2.3", 1],
		["0.15.9", "1.0.0", -1],
		// Prereleases sort before their release (semver §11).
		["1.0.0-beta.1", "1.0.0", -1],
		["1.0.0", "1.0.0-rc.1", 1],
		// The precedence chain from the semver spec.
		["1.0.0-alpha", "1.0.0-alpha.1", -1],
		["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
		["1.0.0-alpha.beta", "1.0.0-beta", -1],
		["1.0.0-beta", "1.0.0-beta.2", -1],
		["1.0.0-beta.2", "1.0.0-beta.11", -1],
		["1.0.0-beta.11", "1.0.0-rc.1", -1],
		["1.0.0-1", "1.0.0-alpha", -1],
		// Build metadata is ignored.
		["1.0.0+build.5", "1.0.0", 0],
		// Leniency for things that aren't semver at all.
		["", "0.0.0", 0],
		["version", "0", 0],
		["2023-06-01", "2023-05-01", 1],
	];

	test.each(cases)("%s vs %s → %i (and the reverse)", (a, b, expected) => {
		expect(Math.sign(compareVersions(a, b))).toBe(expected);
		expect(Math.sign(compareVersions(b, a))).toBe(-expected || 0);
	});
});
