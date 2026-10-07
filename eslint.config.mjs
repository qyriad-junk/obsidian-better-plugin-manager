// The Obsidian community-plugin review bot's ruleset (eslint-plugin-obsidianmd "recommended"), with the same
// overrides as .agent/references/obsidian-sample-plugin-plus/eslint.config.mjs, so `npm run lint` shows what the bot
// would flag. Not enforced in CI yet: it started at ~200 findings; drive them down and then enforce.
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
	{
		ignores: ["main.js", "node_modules/**", ".agent/**", ".sandbox/**", "scripts/**", "tests/**", "*.mjs", "*.mts"],
	},
	// obsidianmd's recommended rules need type information, so only apply them to TS files.
	...obsidianmd.configs.recommended.map((config) => ({ ...config, files: config.files ?? ["**/*.ts"] })),
	{
		files: ["**/*.ts"],
		linterOptions: { reportUnusedDisableDirectives: "error" },
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json", sourceType: "module" },
			globals: {
				...globals.browser,
				// Obsidian's DOM helpers, installed as globals at runtime.
				activeDocument: "readonly",
				activeWindow: "readonly",
				createDiv: "readonly",
				createEl: "readonly",
				createFragment: "readonly",
				createSpan: "readonly",
				createSvg: "readonly",
				sleep: "readonly",
			},
		},
		rules: {
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-empty-function": "off",
			"no-prototype-builtins": "off",
			"@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false, properties: false, returns: false, variables: false } }],
			// Matches the review bot: only warn/error/debug may reach the console.
			"no-console": ["error", { allow: ["warn", "error", "debug"] }],
			"@typescript-eslint/require-await": "error",
		},
	},
]);
