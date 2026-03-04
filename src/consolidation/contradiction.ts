import { cosineSimilarity } from "../activation/embeddings.js";
import { config } from "../config.js";
import type { KnowledgeDB } from "../db/database.js";
import { logger } from "../logger.js";
import { RECONSOLIDATION_THRESHOLD } from "../types.js";
import type { KnowledgeEntry } from "../types.js";
import type { ConsolidationLLM } from "./llm.js";

/**
 * Post-extraction contradiction scanner.
 *
 * Responsibilities:
 * - For each newly inserted/updated entry (changedIds), find topic-overlapping
 *   candidates in the mid-similarity band [contradictionMinSimilarity, RECONSOLIDATION_THRESHOLD).
 *   Entries above the upper bound were already handled by Reconsolidator.decideMerge.
 *   Entries below the lower bound are too dissimilar to plausibly contradict.
 * - Ask the LLM to detect and resolve genuine contradictions.
 * - Apply the resolution to the DB (supersede, merge, or flag as irresolvable).
 * - Track which candidates were already resolved this pass to avoid double-processing.
 */
export class ContradictionScanner {
	private db: KnowledgeDB;
	private llm: ConsolidationLLM;

	constructor(db: KnowledgeDB, llm: ConsolidationLLM) {
		this.db = db;
		this.llm = llm;
	}

	/**
	 * Run the contradiction scan for all changed entries in a chunk.
	 *
	 * Only scans entries that were inserted or updated during this chunk (changedIds).
	 * Pre-existing entries were already checked in a prior consolidation run.
	 *
	 * Returns counts of detected and resolved contradictions.
	 */
	async scan(
		entriesMap: Map<string, KnowledgeEntry & { embedding: number[] }>,
		changedIds: Set<string>,
	): Promise<{ detected: number; resolved: number }> {
		let detected = 0;
		let resolved = 0;

		if (changedIds.size === 0) return { detected, resolved };

		const minSim = config.consolidation.contradictionMinSimilarity;

		// Track entries superseded during this scan pass to avoid double-processing
		// a candidate that was already resolved by an earlier entry in the same pass.
		const supersededInThisScan = new Set<string>();

		// Iterate changedIds directly — O(k) where k = changed entries, not O(n) map size
		for (const id of changedIds) {
			const entry = entriesMap.get(id);
			if (!entry) continue; // was deleted from map (superseded during reconsolidation)
			// Skip if this entry was itself superseded by a previous scan iteration
			if (supersededInThisScan.has(entry.id)) continue;
			if (!entry.topics.length || !entry.embedding) continue;

			// Find topic-overlapping active entries, excluding only entries changed this chunk.
			// Pre-existing entries NOT changed this chunk are valid contradiction candidates.
			// Changed entries are excluded because decideMerge already handled them (sim ≥ 0.82
			// paths) or they're the entry we're checking right now.
			const candidates = this.db.getEntriesWithOverlappingTopics(
				entry.topics,
				[...changedIds], // only exclude chunk-changed entries, not all of entriesMap
			);

			if (candidates.length === 0) continue;

			// Filter to the mid-similarity band: low enough to have been missed by
			// decideMerge, high enough to be plausibly related (not just same topic word)
			const entryEmbedding = entry.embedding;
			const midBandCandidates = candidates.filter((c) => {
				if (supersededInThisScan.has(c.id)) return false; // skip already-resolved candidates
				const sim = cosineSimilarity(entryEmbedding, c.embedding);
				return sim >= minSim && sim < RECONSOLIDATION_THRESHOLD;
			});

			if (midBandCandidates.length === 0) continue;

			logger.log(
				`[contradiction] Checking ${midBandCandidates.length} candidates for "${entry.content.slice(0, 60)}..."`,
			);

			const validCandidateIds = new Set(midBandCandidates.map((c) => c.id));

			const llmStart = Date.now();
			const results = await this.llm.detectAndResolveContradiction(
				{
					id: entry.id,
					content: entry.content,
					type: entry.type,
					topics: entry.topics,
					confidence: entry.confidence,
					createdAt: entry.createdAt,
				},
				midBandCandidates.map((c) => ({
					id: c.id,
					content: c.content,
					type: c.type,
					topics: c.topics,
					confidence: c.confidence,
					createdAt: c.createdAt,
				})),
			);
			logger.log(
				`[contradiction] LLM responded in ${((Date.now() - llmStart) / 1000).toFixed(1)}s (${midBandCandidates.length} candidates).`,
			);

			let entrySuperseded = false;
			for (const result of results) {
				// Guard: reject any candidateId the LLM returned that was not in the
				// input candidate list. A hallucinated ID would silently no-op (UPDATE
				// WHERE id = <non-existent>) or — worse — self-supersede the newEntry
				// if the LLM echoed entry.id back as the candidateId.
				if (!validCandidateIds.has(result.candidateId)) {
					logger.warn(
						`[contradiction] LLM returned candidateId "${result.candidateId}" not in candidate list — skipping`,
					);
					continue;
				}
				detected++;
				logger.log(
					`[contradiction] ${result.resolution}: "${entry.content.slice(0, 50)}..." vs candidate ${result.candidateId.slice(0, 8)}... — ${result.reason}`,
				);

				const mergedData =
					result.resolution === "merge" &&
					result.mergedContent &&
					result.mergedType &&
					result.mergedTopics &&
					result.mergedConfidence !== undefined
						? {
								content: result.mergedContent,
								type: result.mergedType,
								topics: result.mergedTopics,
								confidence: result.mergedConfidence,
							}
						: undefined;

				this.db.applyContradictionResolution(
					result.resolution,
					entry.id,
					result.candidateId,
					mergedData,
				);

				// supersede_old, supersede_new, and merge are all "resolved" — irresolvable needs human
				if (result.resolution !== "irresolvable") {
					resolved++;
				}

				if (
					result.resolution === "supersede_old" ||
					result.resolution === "merge"
				) {
					// Candidate is now superseded — don't let later entries re-process it
					supersededInThisScan.add(result.candidateId);
				}

				if (result.resolution === "supersede_new") {
					// This entry lost — remove from map and stop checking its other candidates
					supersededInThisScan.add(entry.id);
					entriesMap.delete(entry.id);
					entrySuperseded = true;
					break;
				}
			}

			if (entrySuperseded) continue;
		}

		if (detected > 0) {
			logger.log(
				`[contradiction] Scan complete: ${detected} contradictions found, ${resolved} resolved, ${detected - resolved} flagged for review.`,
			);
		}

		return { detected, resolved };
	}
}
