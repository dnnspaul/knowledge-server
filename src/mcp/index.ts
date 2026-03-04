import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// @ts-ignore — Bun supports JSON imports natively
import pkg from "../../package.json" with { type: "json" };
import { contradictionTagBlock, staleTag } from "../activation/format.js";
import { config } from "../config.js";
import type { ActivationResult } from "../types.js";

/**
 * Zod input schema for the `activate` MCP tool.
 * Exported so tests can validate schema constraints without starting the server.
 */
export const activateInputSchema = {
	cues: z
		.string()
		.describe(
			"One or more cues to activate associated knowledge. Can be a question, topic description, or comma-separated keywords. Example: 'churn analysis, segment X, onboarding'",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe(
			`Maximum number of entries to return (default: ${config.activation.maxResults}). Increase when broad topic recall is needed.`,
		),
	threshold: z
		.number()
		.min(0)
		.max(1)
		.optional()
		.describe(
			`Minimum cosine similarity score to include an entry (default: ${config.activation.similarityThreshold}). Lower to cast a wider net (e.g. 0.25), raise to require a tighter match (e.g. 0.45).`,
		),
};

/**
 * MCP server interface for the knowledge system.
 *
 * Exposes a single tool: `activate`
 *
 * Rather than embedding the ActivationEngine directly (which requires DB access
 * and LLM credentials for embedding), this server delegates to the already-running
 * knowledge HTTP server via GET /activate. This keeps the MCP process lightweight:
 * it only needs KNOWLEDGE_HOST / KNOWLEDGE_PORT to find the server.
 *
 * Usage: Agent sends cues (keywords, topics, questions)
 * and receives associated knowledge entries ranked by relevance.
 */

/** Base URL of the knowledge HTTP server, derived from KNOWLEDGE_HOST / KNOWLEDGE_PORT. */
function serverBaseUrl(): string {
	return `http://${config.host}:${config.port}`;
}

async function main() {
	// No validateConfig() call — LLM credentials are not needed here.
	// The knowledge HTTP server holds those; this process is a thin proxy.
	// Connection errors are surfaced per-call with a clear ECONNREFUSED message.
	const baseUrl = serverBaseUrl();

	const server = new McpServer({
		name: "knowledge-server",
		version: pkg.version,
	});

	server.tool(
		"activate",
		"Activate associated knowledge by providing cues. Returns knowledge entries that are semantically related to the provided cues. Use this when you need to recall what has been learned from prior sessions about a specific topic. Provide descriptive cues — topics, questions, or keywords — and receive relevant knowledge entries ranked by association strength.",
		activateInputSchema,
		async ({ cues, limit, threshold }) => {
			try {
				const url = new URL(`${baseUrl}/activate`);
				url.searchParams.set("q", cues);
				if (limit !== undefined) url.searchParams.set("limit", String(limit));
				if (threshold !== undefined)
					url.searchParams.set("threshold", String(threshold));

				const response = await fetch(url, {
					signal: AbortSignal.timeout(15_000),
				});

				if (!response.ok) {
					const body = await response.text();
					return {
						content: [
							{
								type: "text" as const,
								text: `Knowledge server error (${response.status}): ${body}`,
							},
						],
						isError: true,
					};
				}

				const result = (await response.json()) as ActivationResult;

				if (result.entries.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No relevant knowledge found for these cues.",
							},
						],
					};
				}

				const formatted = result.entries
					.map(
						(r, i) =>
							`${i + 1}. [${r.entry.type}] ${r.entry.content}${staleTag(r.staleness)}${contradictionTagBlock(r.contradiction)}\n` +
							`   Topics: ${r.entry.topics.join(", ")}\n` +
							`   Confidence: ${r.entry.confidence} | Scope: ${r.entry.scope} | Semantic match: ${r.rawSimilarity.toFixed(3)} | Score: ${r.similarity.toFixed(3)}`,
					)
					.join("\n\n");

				const conflictCount = result.entries.filter(
					(r) => r.contradiction,
				).length;
				const conflictNote =
					conflictCount > 0
						? ` — ${conflictCount} conflicted, do not act on those without clarifying which version is correct`
						: "";

				return {
					content: [
						{
							type: "text" as const,
							text: `## Activated Knowledge (${result.entries.length} entries, ${result.totalActive} total active${conflictNote})\n\n${formatted}`,
						},
					],
				};
			} catch (e) {
				const isConnRefused =
					String(e).includes("ECONNREFUSED") ||
					String(e).includes("Connection refused");
				const msg = isConnRefused
					? `Cannot reach knowledge server at ${baseUrl}. Is it running? Start it with: knowledge-server`
					: `Error activating knowledge: ${e}`;
				return {
					content: [{ type: "text" as const, text: msg }],
					isError: true,
				};
			}
		},
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("[knowledge-server-mcp] fatal:", err);
		process.exit(1);
	});
}
