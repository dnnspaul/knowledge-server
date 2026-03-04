import { ActivationEngine } from "./activation/activate.js";
import { validateConfig } from "./config.js";
import { ConsolidationEngine } from "./consolidation/consolidate.js";
import { createEpisodeReaders } from "./consolidation/readers/index.js";
import { KnowledgeDB } from "./db/database.js";
import { logger } from "./logger.js";

/**
 * CLI entry point for running knowledge operations directly.
 *
 * Usage:
 *   bun run src/cli.ts consolidate     — Run consolidation
 *   bun run src/cli.ts status          — Show knowledge graph stats
 *   bun run src/cli.ts activate "query" — Test activation
 */
async function main() {
	const command = process.argv[2];

	if (!command || command === "--help" || command === "-h") {
		console.log(`Knowledge Server CLI

Usage:
  bun run src/cli.ts <command> [args]

Commands:
  consolidate     Run a consolidation cycle (process new episodes -> knowledge)
  status          Show knowledge graph statistics
  activate <q>    Test knowledge activation with a query
  review          Show entries needing attention
  reinitialize    Wipe all knowledge and reset cursor (--dry-run to preview, --confirm to apply)
`);
		process.exit(0);
	}

	const errors = validateConfig();
	if (errors.length > 0) {
		console.error("Configuration errors:");
		for (const err of errors) {
			console.error(`  ✗ ${err}`);
		}
		process.exit(1);
	}

	const db = new KnowledgeDB();
	const activation = new ActivationEngine(db);

	try {
		switch (command) {
			case "consolidate": {
				logger.init(""); // disable file logging in CLI mode
				const readers = createEpisodeReaders();
				const consolidation = new ConsolidationEngine(db, activation, readers);
				const result = await consolidation.consolidate();
				console.log("\nConsolidation result:");
				console.log(JSON.stringify(result, null, 2));
				consolidation.close();
				break;
			}

			case "status": {
				const stats = db.getStats();
				const state = db.getConsolidationState();
				console.log("Knowledge Graph Status:");
				console.log(
					JSON.stringify({ knowledge: stats, consolidation: state }, null, 2),
				);
				break;
			}

			case "activate": {
				const query = process.argv[3];
				if (!query) {
					console.error("Usage: bun run src/cli.ts activate <query>");
					process.exit(1);
				}
				const result = await activation.activate(query);
				console.log(`\nActivation results for: "${query}"`);
				console.log(`Total active entries: ${result.totalActive}`);
				console.log(`Matching: ${result.entries.length}`);
				for (const r of result.entries) {
					console.log(`\n  [${r.entry.type}] ${r.entry.content}`);
					console.log(
						`  Semantic match: ${r.rawSimilarity.toFixed(3)} | Score: ${r.similarity.toFixed(3)} | Topics: ${r.entry.topics.join(", ")}`,
					);
				}
				break;
			}

			case "review": {
				const active = db.getActiveEntries();
				const conflicted = db.getEntriesByStatus("conflicted");
				const stale = active.filter((e) => e.strength < 0.3);

				console.log("Knowledge Review:");
				console.log(`  Active entries: ${active.length}`);
				console.log(`  Conflicted: ${conflicted.length}`);
				console.log(`  Stale (strength < 0.3): ${stale.length}`);

				if (conflicted.length > 0) {
					console.log("\nConflicted entries:");
					for (const e of conflicted) {
						console.log(`  - [${e.type}] ${e.content}`);
					}
				}

				if (stale.length > 0) {
					console.log("\nStale entries (consider archiving):");
					for (const e of stale.slice(0, 10)) {
						console.log(
							`  - [${e.type}] ${e.content} (strength: ${e.strength.toFixed(3)})`,
						);
					}
				}
				break;
			}

			case "reinitialize": {
				const flag = process.argv[3];
				const stats = db.getStats();
				const entryCount = stats.total ?? 0;

				if (flag === "--dry-run") {
					console.log("Dry run — no changes made.");
					console.log(
						`Would delete ${entryCount} entries and reset the consolidation cursor.`,
					);
					console.log("Run with --confirm to proceed.");
					break;
				}

				if (flag !== "--confirm") {
					console.log(
						"This will DELETE all knowledge entries and reset the consolidation cursor.",
					);
					console.log(`  Entries that would be deleted: ${entryCount}`);
					console.log(
						"\nRun with --confirm to proceed: bun run src/cli.ts reinitialize --confirm",
					);
					console.log("Run with --dry-run to preview without making changes.");
					process.exit(1);
				}

				db.reinitialize();
				console.log(
					`Knowledge DB reinitialized. ${entryCount} entries deleted, cursor reset.`,
				);
				break;
			}

			default:
				console.error(`Unknown command: ${command}`);
				process.exit(1);
		}
	} finally {
		db.close();
	}
}

main().catch((e) => {
	console.error("Error:", e);
	process.exit(1);
});
