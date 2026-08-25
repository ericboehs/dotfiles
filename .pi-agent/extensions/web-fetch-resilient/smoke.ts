/**
 * Smoke test — loads ../web.ts with a stubbed pi API, verifies both tools
 * register, and runs web_fetch end-to-end. No pi required.
 *   node smoke.ts
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// stub pi's module so web.ts imports resolve outside the agent
const stubDir = join(here, "node_modules", "@earendil-works", "pi-coding-agent");
mkdirSync(stubDir, { recursive: true });
writeFileSync(
	join(stubDir, "package.json"),
	JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "stub.mjs" }),
);
writeFileSync(join(stubDir, "stub.mjs"), "export const getAgentDir = () => process.cwd();");

try {
	const mod = await import(`${here}/../web.ts`);
	const tools: any[] = [];
	await mod.default({ registerTool: (t: any) => tools.push(t) });

	const names = tools.map((t) => t.name).sort();
	console.log(`registered: ${names.join(", ")}`);
	if (!names.includes("web_fetch") || !names.includes("web_search")) {
		throw new Error("expected web_search + web_fetch registrations");
	}

	const fetchTool = tools.find((t) => t.name === "web_fetch");
	const call = fetchTool.renderCall(
		{ url: "https://example.com/" },
		{ fg: (_name: string, text: string) => text, bold: (text: string) => text },
	);
	const renderedCall = JSON.stringify(call.render(200));
	if (!renderedCall.includes("https://example.com/")) throw new Error("renderCall omitted URL");
	console.log("renderCall includes URL");

	const result = await fetchTool.execute("test-id", { url: "https://example.com/" }, undefined, () => {});
	console.log(`execute ok | isError=${result.isError ?? false}`);
	console.log(result.content[0].text.slice(0, 250));
} finally {
	rmSync(stubDir, { recursive: true, force: true });
}
