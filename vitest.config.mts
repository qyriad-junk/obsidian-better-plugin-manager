import { defineConfig } from "vitest/config";
import path from "node:path";

const __dirname = import.meta.dirname;

export default defineConfig({
	resolve: {
		alias: {
			// The real "obsidian" package is types-only at runtime (Obsidian provides it to plugins), so tests get a stub.
			obsidian: path.resolve(__dirname, "tests/support/obsidian-stub.ts"),
			// Mirror tsconfig "paths".
			main: path.resolve(__dirname, "src/main.ts"),
			src: path.resolve(__dirname, "src"),
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		setupFiles: ["tests/support/setup.ts"],
	},
});
