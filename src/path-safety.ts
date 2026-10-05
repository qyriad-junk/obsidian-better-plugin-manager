/**
 * Returns `name` (trimmed) if it is safe to use as a single path segment under a BPM-managed
 * folder such as `<configDir>/plugins/` or `<configDir>/themes/`, or "" if it is not.
 *
 * Plugin ids and theme names come from remote manifests and transfer packages, so they must
 * not be able to escape their parent folder (`..`, separators) or name a drive (`C:`).
 */
export const getSafePathSegment = (name: string): string => {
	const segment = (name || "").trim();
	if (!segment || segment === "." || segment === "..") return "";
	if (segment.includes("/") || segment.includes("\\") || segment.includes(":")) return "";
	return segment;
};
