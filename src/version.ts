/**
 * Version comparison shared by update checks, source tracking and migrations.
 *
 * Follows semver precedence (https://semver.org/#spec-item-11), but parses leniently, because
 * plugin manifests and GitHub release tags are not always valid semver:
 * - a leading "v" (as in release tags like "v1.2.3") is ignored;
 * - missing components count as 0 ("1.2" == "1.2.0"), and so does a component without leading digits;
 * - build metadata ("+build.5") is ignored.
 *
 * A prerelease sorts *before* its release ("1.0.0-beta.1" < "1.0.0"), and prerelease identifiers
 * compare numerically when both are numeric ("beta.2" < "beta.10").
 */

type ParsedVersion = {
	core: number[];
	prerelease: string[];
};

const parseVersion = (input: string | null | undefined): ParsedVersion => {
	const withoutBuild = (input ?? "").trim().replace(/^v(?=\d)/i, "").split("+")[0];
	const dashIndex = withoutBuild.indexOf("-");
	const coreText = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
	const prereleaseText = dashIndex === -1 ? "" : withoutBuild.slice(dashIndex + 1);

	const core = coreText.split(".").map((part) => {
		const digits = part.match(/^\d+/);
		return digits ? Number(digits[0]) : 0;
	});
	const prerelease = prereleaseText ? prereleaseText.split(".") : [];
	return { core, prerelease };
};

const isNumericIdentifier = (identifier: string): boolean => /^\d+$/.test(identifier);

const compareNumbers = (a: number, b: number): number => (a > b ? 1 : a < b ? -1 : 0);

const comparePrereleaseIdentifiers = (a: string, b: string): number => {
	const aNumeric = isNumericIdentifier(a);
	const bNumeric = isNumericIdentifier(b);
	if (aNumeric && bNumeric) return compareNumbers(Number(a), Number(b));
	// Numeric identifiers have lower precedence than alphanumeric ones.
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	return a > b ? 1 : a < b ? -1 : 0;
};

/** Returns 1 if a > b, -1 if a < b, 0 if they have the same precedence. */
export const compareVersions = (a: string | null | undefined, b: string | null | undefined): number => {
	const left = parseVersion(a);
	const right = parseVersion(b);

	const coreLength = Math.max(left.core.length, right.core.length);
	for (let i = 0; i < coreLength; i++) {
		const result = compareNumbers(left.core[i] ?? 0, right.core[i] ?? 0);
		if (result !== 0) return result;
	}

	// Same core version: a release outranks any of its prereleases.
	const leftIsRelease = left.prerelease.length === 0;
	const rightIsRelease = right.prerelease.length === 0;
	if (leftIsRelease && rightIsRelease) return 0;
	if (leftIsRelease) return 1;
	if (rightIsRelease) return -1;

	const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
	for (let i = 0; i < prereleaseLength; i++) {
		// A shorter set of identifiers has lower precedence when all preceding ones are equal.
		if (left.prerelease[i] === undefined) return -1;
		if (right.prerelease[i] === undefined) return 1;
		const result = comparePrereleaseIdentifiers(left.prerelease[i], right.prerelease[i]);
		if (result !== 0) return result;
	}
	return 0;
};
