import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { IKnowledgeDB } from "../db/interface.js";
import { logger } from "../logger.js";
import type { Episode, IEpisodeReader, PendingEpisode } from "../types.js";

/**
 * EpisodeUploader — the daemon's core upload loop.
 *
 * For each configured episode reader (OpenCode, Claude Code, Cursor, etc.):
 *   1. Reads the daemon cursor to find the high-water mark for this source
 *   2. Calls getCandidateSessions to find new sessions
 *   3. Calls getNewEpisodes to get unprocessed episode content
 *   4. Writes each episode to the pending_episodes staging table
 *   5. Advances the daemon cursor
 *
 * The daemon DB (targetDb) can be:
 *   - The same local SQLite as the consolidation engine (single-machine setup)
 *   - A remote Postgres (cross-device / multi-user setup)
 *
 * In both cases the daemon cursor is always read/written from localDb (local SQLite),
 * while episodes are written to targetDb (which may be remote Postgres).
 * This keeps the cursor local even when episodes go to a remote DB.
 */
export class EpisodeUploader {
	private readonly readers: IEpisodeReader[];
	private readonly localDb: IKnowledgeDB;
	private readonly targetDb: IKnowledgeDB;
	private readonly userId: string;

	/**
	 * @param readers   Episode readers — one per AI tool source.
	 * @param localDb   Local SQLite DB for daemon cursor reads/writes.
	 * @param targetDb  Target DB for pending_episodes writes. May be the same as
	 *                  localDb (single-machine) or a remote Postgres instance.
	 * @param userId    Stable user identifier (KNOWLEDGE_USER_ID or hostname).
	 */
	constructor(
		readers: IEpisodeReader[],
		localDb: IKnowledgeDB,
		targetDb: IKnowledgeDB,
		userId: string,
	) {
		this.readers = readers;
		this.localDb = localDb;
		this.targetDb = targetDb;
		this.userId = userId;
	}

	/**
	 * Run one upload cycle — process all readers and upload new episodes.
	 * Returns a summary of what was uploaded.
	 */
	async upload(): Promise<{
		episodesUploaded: number;
		sessionsProcessed: number;
		sources: Array<{ source: string; episodes: number; sessions: number }>;
	}> {
		let totalEpisodes = 0;
		let totalSessions = 0;
		const sources: Array<{
			source: string;
			episodes: number;
			sessions: number;
		}> = [];

		for (const reader of this.readers) {
			try {
				const result = await this.uploadSource(reader);
				totalEpisodes += result.episodes;
				totalSessions += result.sessions;
				if (result.episodes > 0 || result.sessions > 0) {
					sources.push({
						source: reader.source,
						episodes: result.episodes,
						sessions: result.sessions,
					});
				}
			} catch (err) {
				// Per-source failure: log and continue with other sources.
				// Same philosophy as the consolidation engine's per-source try/catch.
				logger.error(
					`[daemon/${reader.source}] Upload failed — skipping source this run:`,
					err,
				);
			}
		}

		if (totalEpisodes > 0) {
			logger.log(
				`[daemon] Uploaded ${totalEpisodes} episodes from ${totalSessions} sessions.`,
			);
		}

		return {
			episodesUploaded: totalEpisodes,
			sessionsProcessed: totalSessions,
			sources,
		};
	}

	private async uploadSource(
		reader: IEpisodeReader,
	): Promise<{ episodes: number; sessions: number }> {
		// Read daemon cursor from LOCAL db — always machine-local regardless of targetDb.
		const cursor = await this.localDb.getDaemonCursor(reader.source);

		const candidateSessions = reader.getCandidateSessions(
			cursor.lastMessageTimeCreated,
			config.consolidation.maxSessionsPerRun,
		);

		if (candidateSessions.length === 0) {
			return { episodes: 0, sessions: 0 };
		}

		const candidateIds = candidateSessions.map((s) => s.id);

		// Load already-uploaded episodes to skip re-uploading on restart.
		// Scoped to candidateIds so we only check the sessions we're about to upload.
		const processedRanges =
			await this.targetDb.getProcessedEpisodeRanges(candidateIds);

		// Also check what's already pending (uploaded but not yet consolidated).
		// Scoped to cursor.lastMessageTimeCreated so we only scan the relevant
		// window rather than the entire table — avoids O(table_size) fetches when
		// pending rows accumulate (e.g. server is offline for days).
		const alreadyPending = await this.targetDb.getPendingEpisodes(
			cursor.lastMessageTimeCreated,
		);
		// Filter to this source only — getPendingEpisodes now returns all sources.
		const pendingSet = new Set(
			alreadyPending
				.filter((ep) => ep.source === reader.source)
				.map((ep) => `${ep.sessionId}|${ep.startMessageId}|${ep.endMessageId}`),
		);

		let episodes: Episode[];
		try {
			episodes = reader.getNewEpisodes(candidateIds, processedRanges);
		} catch (err) {
			logger.error(`[daemon/${reader.source}] getNewEpisodes failed:`, err);
			return { episodes: 0, sessions: 0 };
		}

		// Filter out episodes already in pending_episodes
		const newEpisodes = episodes.filter(
			(ep) =>
				!pendingSet.has(
					`${ep.sessionId}|${ep.startMessageId}|${ep.endMessageId}`,
				),
		);

		let uploadedCount = 0;
		const uploadedSessionIds = new Set<string>();

		for (const ep of newEpisodes) {
			const pending: PendingEpisode = {
				id: randomUUID(),
				userId: this.userId,
				source: reader.source,
				sessionId: ep.sessionId,
				startMessageId: ep.startMessageId,
				endMessageId: ep.endMessageId,
				sessionTitle: ep.sessionTitle,
				projectName: ep.projectName,
				directory: ep.directory,
				timeCreated: ep.timeCreated,
				maxMessageTime: ep.maxMessageTime,
				content: ep.content,
				contentType: ep.contentType,
				approxTokens: ep.approxTokens,
				uploadedAt: Date.now(),
			};
			await this.targetDb.insertPendingEpisode(pending);
			uploadedCount++;
			uploadedSessionIds.add(ep.sessionId);
		}

		// Advance daemon cursor — mirrors consolidation engine's boundary-safety logic.
		const lastSession = candidateSessions[candidateSessions.length - 1];
		const hitBatchLimit =
			candidateSessions.length === config.consolidation.maxSessionsPerRun;

		const maxTime = episodes.reduce(
			(max, ep) => Math.max(max, ep.maxMessageTime),
			cursor.lastMessageTimeCreated,
		);

		let newCursor = maxTime;
		if (hitBatchLimit) {
			const cap = lastSession.maxMessageTime - 1;
			// Only cap if it would not move the cursor backward.
			if (cap > cursor.lastMessageTimeCreated) {
				newCursor = Math.min(newCursor, cap);
			}
		} else {
			// Batch not full — advance past all candidates so sessions that produced
			// no episodes don't re-appear as candidates next run.
			newCursor = Math.max(newCursor, lastSession.maxMessageTime);
		}

		// Safety floor: never move the cursor backwards.
		newCursor = Math.max(newCursor, cursor.lastMessageTimeCreated);

		// Write daemon cursor to LOCAL db.
		await this.localDb.updateDaemonCursor(reader.source, {
			lastMessageTimeCreated: newCursor,
			lastUploadedAt: Date.now(),
		});

		if (uploadedCount > 0) {
			logger.log(
				`[daemon/${reader.source}] Uploaded ${uploadedCount} episodes from ${uploadedSessionIds.size} sessions.`,
			);
		}

		return {
			episodes: uploadedCount,
			sessions: uploadedSessionIds.size,
		};
	}

	/**
	 * Run the daemon in polling mode — upload on interval until stopped.
	 *
	 * @param intervalMs  Upload interval in milliseconds (default: 5 minutes).
	 * @param onShutdown  Optional async cleanup callback called before process.exit.
	 *                    Use this to close DB connections and readers gracefully.
	 */
	async runPolling(
		intervalMs = 5 * 60 * 1000,
		onShutdown?: () => Promise<void>,
	): Promise<void> {
		logger.log(
			`[daemon] Starting. Upload interval: ${Math.round(intervalMs / 1000)}s. User: ${this.userId}`,
		);

		// Run immediately on start
		await this.upload();

		const interval = setInterval(async () => {
			await this.upload().catch((err) => {
				logger.error("[daemon] Upload cycle failed:", err);
			});
		}, intervalMs);

		// Graceful shutdown: stop the interval, run caller cleanup, then exit.
		// Uses process.on (not once) so both SIGTERM and SIGINT are always handled.
		// The re-entrancy guard prevents double-cleanup if both signals fire in rapid
		// succession before the async onShutdown resolves (process.once would leave
		// the second signal unhandled, causing a hard exit mid-onShutdown).
		let shuttingDown = false;
		const cleanup = async () => {
			if (shuttingDown) return;
			shuttingDown = true;
			clearInterval(interval);
			logger.log("[daemon] Stopping…");
			if (onShutdown) {
				await onShutdown().catch((err) => {
					logger.error("[daemon] Error during shutdown:", err);
				});
			}
			logger.log("[daemon] Stopped.");
			process.exit(0);
		};

		process.on("SIGTERM", () => void cleanup());
		process.on("SIGINT", () => void cleanup());
	}
}
