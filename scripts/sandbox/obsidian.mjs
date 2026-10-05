#!/usr/bin/env node
// Drive the sandbox Obsidian (see launch.sh) over the Chrome DevTools Protocol.
//
//   node scripts/sandbox/obsidian.mjs eval '<expression>'      print the awaited value as JSON
//   node scripts/sandbox/obsidian.mjs run '<async fn body>'    same, but a function body (use `return`)
//   node scripts/sandbox/obsidian.mjs screenshot [file.png]    default: .sandbox/screenshot.png
//   node scripts/sandbox/obsidian.mjs command <command-id>     e.g. better-plugins-manager:manager-view
//   node scripts/sandbox/obsidian.mjs reload                   full app reload = a real Obsidian startup
//   node scripts/sandbox/obsidian.mjs trust                    turn off restricted mode (reloads if needed)
//
// `app` is Obsidian's global App in evaluated code. Also importable: connect(), waitForWorkspace().
import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SANDBOX = process.env.BPM_SANDBOX ?? path.join(REPO, ".sandbox");
const PORT = process.env.BPM_SANDBOX_PORT ?? "9222";

export async function connect() {
	const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
	const page = browser.contexts()[0]?.pages().find((p) => p.url().startsWith("app://obsidian.md/"));
	if (!page) throw new Error(`No Obsidian window found on CDP port ${PORT}; is launch.sh running?`);
	return { browser, page };
}

/** Wait until the workspace is ready, then give delayed work `settleMs` to run. */
export async function waitForWorkspace(page, settleMs = 1000) {
	await page.waitForFunction(() => window.app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
	await page.waitForTimeout(settleMs);
}

export async function reload(page, settleMs) {
	await page.evaluate(() => location.reload());
	await page.waitForLoadState("domcontentloaded");
	await waitForWorkspace(page, settleMs);
}

async function main([command, ...args]) {
	const { browser, page } = await connect();
	try {
		switch (command) {
			case "eval":
			case "run": {
				const body = command === "eval" ? `return (${args.join(" ")});` : args.join(" ");
				const value = await page.evaluate(`(async () => { ${body} })()`);
				console.log(JSON.stringify(value, null, 2));
				break;
			}
			case "screenshot": {
				const file = args[0] ?? path.join(SANDBOX, "screenshot.png");
				await page.screenshot({ path: file });
				console.log(file);
				break;
			}
			case "command":
				console.log(await page.evaluate((id) => app.commands.executeCommandById(id), args[0]));
				break;
			case "reload":
				await reload(page, Number(args[0] ?? 1000));
				break;
			case "trust": {
				await waitForWorkspace(page, 0);
				const restricted = await page.evaluate(() => !app.plugins.isEnabled());
				if (restricted) {
					await page.evaluate(() => localStorage.setItem(`enable-plugin-${app.appId}`, "true"));
					await reload(page);
				}
				break;
			}
			default:
				console.error("usage: obsidian.mjs eval|run|screenshot|command|reload|trust …");
				process.exitCode = 2;
		}
	} finally {
		await browser.close(); // disconnects; doesn't quit Obsidian
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message ?? error);
		process.exitCode = 1;
	});
}
