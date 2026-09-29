import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentSystemMessage, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Mirrors the production proxy: services/ai/prompts/system.py, services/ai/tools.py, services/github_knowledge.py.
const EVA_TOOLS = ["read_skill", "colleague_handoff"];

async function systemPrompt(knowledge: string) {
	const skill = await readFile(join(knowledge, "Skill.md"), "utf8");
	const today = new Date().toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" });
	return [
		skill.replace(/^#\s+Skill\s*\n+/, ""),
		"",
		"Use the `read_skill` tool to load any topic listed above. " +
			"You MUST read the relevant topic BEFORE answering any question " +
			"that falls within its scope. Do not guess or improvise when a " +
			"relevant topic is available — read it first.",
		"",
		"You may read multiple topics in a single turn if needed. " +
			"If no topic is relevant, answer using your general knowledge.",
		"",
		`Today is ${today}`,
	].join("\n");
}

async function readTopic(knowledge: string, name: string) {
	const topics = (await readdir(knowledge, { withFileTypes: true }))
		.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md") && e.name.toLowerCase() !== "skill.md")
		.map((e) => e.name.slice(0, -3))
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const wanted = name.toLowerCase();
	const match = topics.find((t) => t.toLowerCase() === wanted) ?? topics.find((t) => t.toLowerCase().includes(wanted));
	if (match === undefined) return `Skill topic '${name}' not found. Available topics: ${topics.join(", ")}`;
	return readFile(join(knowledge, `${match}.md`), "utf8");
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export default function eva(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_skill",
		label: "read_skill",
		description:
			"Load a skill topic by name to get detailed scenarios, procedures, " +
			"and examples. You MUST call this tool before answering any question " +
			"that falls within a listed topic's scope.",
		parameters: Type.Object({
			name: Type.String({ description: "The name of the topic to read, as listed in the skill catalog" }),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => text(await readTopic(join(ctx.cwd, "knowledge"), params.name)),
	});

	pi.registerTool({
		name: "colleague_handoff",
		label: "colleague_handoff",
		description: "Use this tool to hand off the conversation to your colleague.",
		parameters: Type.Object({
			english_query: Type.String({ description: "The query in english to hand off to your colleague." }),
		}),
		execute: async () =>
			text("The team will look into this, they will *update* in the chat as soon as possible. Please give us some time."),
		renderCall: (args, theme) =>
			new Text(theme.fg("warning", theme.bold("Handoff to clinic team: ")) + theme.fg("accent", args.english_query ?? ""), 0, 0),
	});

	pi.on("session_start", () => pi.setActiveTools(EVA_TOOLS));

	pi.on("before_agent_start", async (_event, ctx) => {
		pi.setActiveTools(EVA_TOOLS);
		return { systemPrompt: await systemPrompt(join(ctx.cwd, "knowledge")) };
	});

	// Other extensions can add tools after before_agent_start (pi-web-access adds web_enable);
	// this runs before every model request, so Eva only ever sees her own tools.
	pi.on("context_with_system", (event) => {
		const system = getCurrentSystemMessage(event.messages);
		if (!system) return;
		const toolsAdded = system.toolsAdded?.filter((tool) => EVA_TOOLS.includes(tool.name));
		return { messages: [{ ...system, toolsAdded }, ...event.messages.filter((m) => m.role !== "system")] };
	});
}
