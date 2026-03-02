import type { KnowledgeDB } from "../db/database.js";
import type { ActivationEngine } from "../activation/activate.js";
import type { EmbeddingClient } from "../activation/embeddings.js";
import { EpisodeReader } from "./episodes.js";
import { ConsolidationLLM, formatEpisodes, formatExistingKnowledge } from "./llm.js";
import { Reconsolidator } from "./reconsolidate.js";
import { ContradictionScanner } from "./contradiction.js";
import { computeStrength } from "./decay.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { KnowledgeEntry } from "../types.js";
import type { ConsolidationResult } from "../types.js";

/**
 * The consolidation engine — the heart of the knowledge system.
 *
 * Orchestrates the full consolidation pipeline, delegating specialised work to:
 * - EpisodeReader         — fetches raw sessions/episodes from the OpenCode DB
 * - ConsolidationLLM      — wraps all LLM calls (extract, merge, contradiction)
 * - Reconsolidator        — deduplicates extracted entries against existing knowledge
 * - ContradictionScanner  — detects and resolves contradictions in the mid-similarity band
 *
 * Models the human brain's sleep consolidation process:
 * 1. Read NEW episodes (since last consolidation cursor)
 * 2. Load EXISTING knowledge (the current mental model)
 * 3. Extract new knowledge from episodes (what's worth remembering?)
 * 4. Reconsolidate — deduplicate/merge against existing knowledge
 * 5. Contradiction scan — detect and resolve conflicts in the mid-band
 * 6. Apply decay to all entries (forgetting curve)
 * 7. Generate embeddings for new entries
 * 8. Advance the cursor
 */
export class ConsolidationEngine {
  private db: KnowledgeDB;
  private activation: ActivationEngine;
  private embeddings: EmbeddingClient;
  private episodes: EpisodeReader;
  private llm: ConsolidationLLM;
  private reconsolidator: Reconsolidator;
  private contradictionScanner: ContradictionScanner;

  /**
   * Concurrency guard — only one consolidation run at a time, regardless of
   * whether it was triggered by the startup background loop or an API call.
   * Lives here (not in the API closure) so both paths share the same flag.
   *
   * Use tryLock() / unlock() instead of mutating directly — this keeps external
   * callers from accidentally bypassing or prematurely clearing the guard.
   */
  private _isConsolidating = false;

  get isConsolidating(): boolean {
    return this._isConsolidating;
  }

  /**
   * Atomically claim the consolidation lock.
   * Returns true if the lock was acquired (caller should proceed),
   * false if another run is already in progress (caller should abort).
   *
   * Must be called synchronously (no await before this call) to be race-free
   * under Node/Bun's single-threaded event loop.
   */
  tryLock(): boolean {
    if (this._isConsolidating) return false;
    this._isConsolidating = true;
    return true;
  }

  unlock(): void {
    this._isConsolidating = false;
  }

  constructor(db: KnowledgeDB, activation: ActivationEngine) {
    this.db = db;
    this.activation = activation;
    // Reuse the EmbeddingClient from ActivationEngine — one shared HTTP client
    // for both retrieval and consolidation embedding calls.
    this.embeddings = activation.embeddings;
    this.episodes = new EpisodeReader();
    this.llm = new ConsolidationLLM();
    this.reconsolidator = new Reconsolidator(db, this.embeddings, this.llm);
    this.contradictionScanner = new ContradictionScanner(db, this.llm);
  }

  /**
   * Check how many sessions are pending consolidation without running it.
   * Used at startup to decide whether to kick off a background consolidation.
   */
  checkPending(): { pendingSessions: number; lastConsolidatedAt: number } {
    const state = this.db.getConsolidationState();
    const pending = this.episodes.countNewSessions(state.lastMessageTimeCreated);
    return { pendingSessions: pending, lastConsolidatedAt: state.lastConsolidatedAt };
  }

  /**
   * Run a consolidation cycle.
   *
   * This is the main entry point — called by HTTP API or CLI.
   *
   * Per-run steps:
   * 1. Fetch candidate sessions since the cursor
   * 2. Load already-processed episode ranges to determine new work
   * 3. Segment sessions into episodes, skipping already-processed ranges
   * 4. For each chunk: extract → reconsolidate → contradiction scan → record episodes
   * 5. Apply decay to all active entries
   * 6. Generate embeddings for new/updated entries
   * 7. Advance the session cursor past all fetched candidates
   */
  async consolidate(): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const state = this.db.getConsolidationState();

    logger.log(
      `[consolidation] Starting. Last run: ${state.lastConsolidatedAt ? new Date(state.lastConsolidatedAt).toISOString() : "never"}`
    );

    // 1. Fetch candidate sessions: those with messages newer than the cursor.
    //    Returns session IDs plus the max message timestamp per session,
    //    ordered by max message time ASC for deterministic batching.
    const candidateSessions = this.episodes.getCandidateSessions(
      state.lastMessageTimeCreated,
      config.consolidation.maxSessionsPerRun
    );

    if (candidateSessions.length === 0) {
      logger.log("[consolidation] No new sessions to process.");
      // Still run decay — entries must age even during quiet periods where no
      // new sessions arrive. Without this, the forgetting curve stops ticking.
      const archived = this.applyDecay();
      await this.activation.ensureEmbeddings();
      return {
        sessionsProcessed: 0,
        segmentsProcessed: 0,
        entriesCreated: 0,
        entriesUpdated: 0,
        entriesArchived: archived,
        conflictsDetected: 0,
        conflictsResolved: 0,
        duration: Date.now() - startTime,
      };
    }

    const candidateIds = candidateSessions.map((s) => s.id);

    // 2. Load already-processed episode ranges for this batch of sessions.
    const processedRanges = this.db.getProcessedEpisodeRanges(candidateIds);

    // 3. Segment sessions into episodes, skipping already-processed ranges.
    const episodes = this.episodes.getNewEpisodes(candidateIds, processedRanges);

    // Count unique sessions that produced at least one new episode
    const uniqueSessionIds = new Set(episodes.map((e) => e.sessionId));

    // Directly classify each skipped session rather than computing by subtraction
    // (subtraction can go negative for partially-processed sessions that still have new episodes).
    let alreadyDone = 0; // had prior episodes recorded, nothing new
    let tooFew = 0;      // no prior episodes, didn't pass minSessionMessages filter
    for (const id of candidateIds) {
      if (uniqueSessionIds.has(id)) continue; // produced new episodes — not skipped
      if (processedRanges.has(id)) {
        alreadyDone++;  // some episodes were previously recorded; no new tail
      } else {
        tooFew++;       // never produced episodes — below minSessionMessages
      }
    }

    logger.log(
      `[consolidation] Found ${episodes.length} episodes from ${uniqueSessionIds.size} sessions to process` +
      ` (${tooFew} skipped — too few messages, ${alreadyDone} skipped — already processed).`
    );

    // 4. Process episodes in chunks
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalConflictsDetected = 0;
    let totalConflictsResolved = 0;

    const chunkSize = config.consolidation.chunkSize;

    for (let i = 0; i < episodes.length; i += chunkSize) {
      const chunk = episodes.slice(i, i + chunkSize);
      const chunkSummary = formatEpisodes(chunk);

      logger.log(
        `[consolidation] Processing chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(episodes.length / chunkSize)} (${chunk.length} episodes)`
      );

      // Load entries once for this chunk — used both for relevance selection
      // (prompt context) and reconsolidation (dedup). Loaded here so getRelevantKnowledge
      // doesn't make a second DB call when we immediately need the same data below.
      const allEntriesForChunk = this.db.getActiveEntriesWithEmbeddings();

      // Retrieve only RELEVANT existing knowledge for this chunk
      // (instead of dumping the entire knowledge base into the prompt)
      const relevantKnowledge = await this.reconsolidator.getRelevantKnowledge(chunkSummary, allEntriesForChunk);
      const existingKnowledgeSummary = formatExistingKnowledge(relevantKnowledge);

      logger.log(
        `[consolidation] Using ${relevantKnowledge.length} relevant existing entries as context.`
      );

      // Extract knowledge via LLM
      const extractStart = Date.now();
      const extracted = await this.llm.extractKnowledge(
        chunkSummary,
        existingKnowledgeSummary
      );
      logger.log(
        `[consolidation] Extracted ${extracted.length} knowledge entries from chunk in ${((Date.now() - extractStart) / 1000).toFixed(1)}s.`
      );

      // Reconsolidate each extracted entry against existing knowledge.
      // For each extracted entry:
      //   1. Embed it
      //   2. Find the nearest existing entry by cosine similarity
      //   3. If similarity > RECONSOLIDATION_THRESHOLD: ask LLM to decide
      //      keep / update / replace / insert
      //   4. Act on the decision
      //
      // Performance: load all entries with embeddings ONCE per chunk into an in-memory
      // Map. On insert/update, mutate the Map in place rather than reloading from DB.
      // This avoids an O(n × m) reload — previously ~9.7 MB × m reads per chunk.
      const sessionIds = [...new Set(chunk.map((e) => e.sessionId))];
      // Reuse the entries already loaded for getRelevantKnowledge — no second DB read.
      const entriesMap = new Map(allEntriesForChunk.map((e) => [e.id, e]));
      let chunkCreated = 0;
      let chunkUpdated = 0;

      // Track IDs that were inserted or updated this chunk — only these are
      // eligible for the contradiction scan (pre-existing entries were already
      // checked in a previous consolidation run).
      const changedIds = new Set<string>();

      for (const entry of extracted) {
        try {
          await this.reconsolidator.reconsolidate(entry, sessionIds, entriesMap, {
            onInsert: (inserted) => {
              totalCreated++;
              chunkCreated++;
              changedIds.add(inserted.id);
              // Add to cache so subsequent entries in this chunk can deduplicate against it.
              // Embedding is available immediately since insertNewEntry stores it.
              if (inserted.embedding) {
                entriesMap.set(inserted.id, inserted as KnowledgeEntry & { embedding: number[] });
              }
            },
            onUpdate: (id, updated, freshEmbedding) => {
              totalUpdated++;
              chunkUpdated++;
              changedIds.add(id);
              // Update the cache with the new content and fresh embedding.
              // The fresh embedding was computed immediately after mergeEntry() and
              // written to the DB, so the in-memory map and DB are now in sync.
              // Later extractions in this chunk can deduplicate against the correct
              // vector, and the contradiction scan sees accurate cosine distances.
              const existing = entriesMap.get(id);
              if (existing) {
                entriesMap.set(id, {
                  ...existing,
                  content: updated.content ?? existing.content,
                  type: (updated.type as KnowledgeEntry["type"]) ?? existing.type,
                  topics: updated.topics ?? existing.topics,
                  confidence: updated.confidence ?? existing.confidence,
                  embedding: freshEmbedding,
                });
              }
            },
            onKeep: () => {},
          });
        } catch (err) {
          // Log and skip this extracted entry — do NOT rethrow.
          // Rethrowing would skip recordEpisode for the whole chunk, causing all
          // entries in this chunk to be re-processed on the next run and producing
          // duplicates for the entries that were already successfully inserted.
          logger.error(
            `[consolidation] Failed to reconsolidate entry "${String(entry.content ?? "").slice(0, 60)}..." — skipping:`,
            err
          );
        }
      }

      // 5. Post-extraction contradiction scan.
      //    Delegates to ContradictionScanner — finds mid-band candidates and resolves.
      const chunkContradictions = await this.contradictionScanner.scan(entriesMap, changedIds);
      totalConflictsDetected += chunkContradictions.detected;
      totalConflictsResolved += chunkContradictions.resolved;

      // 6. Record each episode in this chunk as processed.
      //    This happens after the LLM call and DB writes succeed, making
      //    consolidation idempotent on crash/retry at the episode level.
      //    entriesCreated is split evenly across episodes in the chunk as an approximation
      //    (we don't track which entries came from which specific episode).
      const entriesPerEp = chunk.length > 0 ? Math.round((chunkCreated + chunkUpdated) / chunk.length) : 0;
      for (const ep of chunk) {
        this.db.recordEpisode(
          ep.sessionId,
          ep.startMessageId,
          ep.endMessageId,
          ep.contentType,
          entriesPerEp
        );
      }
    }

    // 7. Apply decay to ALL active entries
    const archived = this.applyDecay();

    // 8. Generate embeddings for new entries
    const embeddedCount = await this.activation.ensureEmbeddings();
    logger.log(
      `[consolidation] Generated embeddings for ${embeddedCount} entries.`
    );

    // 9. Advance cursor to the max message timestamp across all processed episodes.
    //    This is the true high-water mark: any message with time_created > this value
    //    is genuinely unprocessed.
    const maxEpisodeMessageTime = episodes.length > 0
      ? episodes.reduce((max, ep) => ep.maxMessageTime > max ? ep.maxMessageTime : max, 0)
      : 0;

    // Start with the episode high-water mark; we'll decide below whether to also
    // advance past sessions that produced no episodes.
    let newCursor = Math.max(maxEpisodeMessageTime, state.lastMessageTimeCreated);

    const lastSession = candidateSessions[candidateSessions.length - 1];
    const hitBatchLimit = candidateSessions.length === config.consolidation.maxSessionsPerRun;

    // Boundary-timestamp safety: if the batch is full, there may be additional
    // unprocessed sessions beyond the batch boundary that share the exact same
    // maxMessageTime as the last session in this batch. The next query uses `>`,
    // so those sessions would be excluded forever if we advance the cursor to
    // lastSession.maxMessageTime.
    //
    // Guard: keep the cursor just below the boundary so those sessions are
    // re-fetched next run. Apply this cap whenever the batch is full, regardless
    // of whether the last session produced an episode — a session without episodes
    // (e.g. below minSessionMessages) could still share a timestamp with other
    // sessions that DO have episodes and are waiting beyond the boundary.
    //
    // We only apply the cap when it is strictly above the current cursor
    // (otherwise the safety floor below would undo it on the next line).
    if (hitBatchLimit) {
      // Cap below boundary; re-fetch same-timestamp sessions next run.
      const cap = lastSession.maxMessageTime - 1;
      if (cap > state.lastMessageTimeCreated) {
        newCursor = Math.min(newCursor, cap);
      }
    } else {
      // Batch is not full — no boundary risk. Advance past all candidates so
      // sessions that produced no episodes don't re-appear as candidates.
      newCursor = Math.max(newCursor, lastSession.maxMessageTime);
    }

    // Safety floor: never move the cursor backwards.
    newCursor = Math.max(newCursor, state.lastMessageTimeCreated);

    this.db.updateConsolidationState({
      lastConsolidatedAt: Date.now(),
      lastMessageTimeCreated: newCursor,
      totalSessionsProcessed: state.totalSessionsProcessed + candidateSessions.length,
      totalEntriesCreated: state.totalEntriesCreated + totalCreated,
      totalEntriesUpdated: state.totalEntriesUpdated + totalUpdated,
    });

    const result: ConsolidationResult = {
      sessionsProcessed: candidateSessions.length,
      segmentsProcessed: episodes.length,
      entriesCreated: totalCreated,
      entriesUpdated: totalUpdated,
      entriesArchived: archived,
      conflictsDetected: totalConflictsDetected,
      conflictsResolved: totalConflictsResolved,
      duration: Date.now() - startTime,
    };

    logger.log(
      `[consolidation] Complete. ${result.sessionsProcessed} sessions (${result.segmentsProcessed} segments) -> ${result.entriesCreated} entries (${result.entriesArchived} archived, ${result.conflictsDetected} conflicts, ${result.conflictsResolved} resolved) in ${result.duration}ms`
    );

    return result;
  }

  /**
   * Apply decay to all active entries.
   * Returns the number of entries that were archived.
   */
  private applyDecay(): number {
    // Include conflicted entries — their strength must continue aging.
    // A conflicted entry whose strength falls to zero is effectively forgotten
    // regardless of the conflict, and should still be archived.
    // Single query avoids the TOCTOU window of two separate status queries.
    const entries = this.db.getActiveAndConflictedEntries();
    let archived = 0;

    for (const entry of entries) {
      const newStrength = computeStrength(entry);

      if (newStrength < config.decay.archiveThreshold) {
        this.db.updateEntry(entry.id, {
          status: "archived",
          strength: newStrength,
        });
        archived++;
        logger.log(
          `[decay] Archived: "${entry.content.slice(0, 60)}..." (strength: ${newStrength.toFixed(3)})`
        );
      } else if (Math.abs(newStrength - entry.strength) > 0.01) {
        // Only update if strength changed meaningfully
        this.db.updateStrength(entry.id, newStrength);
      }
    }

    // Tombstone long-archived entries
    const archivedEntries = this.db.getEntriesByStatus("archived");
    const tombstoneThreshold =
      Date.now() - config.decay.tombstoneAfterDays * 24 * 60 * 60 * 1000;

    for (const entry of archivedEntries) {
      if (entry.updatedAt < tombstoneThreshold) {
        this.db.updateEntry(entry.id, { status: "tombstoned" });
        logger.log(
          `[decay] Tombstoned: "${entry.content.slice(0, 60)}..." (archived for ${config.decay.tombstoneAfterDays}+ days)`
        );
      }
    }

    return archived;
  }

  close(): void {
    this.episodes.close();
  }
}
