/**
 * Tests for the consolidation lock (tryAcquireConsolidationLock / releaseConsolidationLock).
 *
 * Tests cover:
 * - SQLite: in-process re-entrancy prevention
 * - ConsolidationEngine: skips and returns empty result when lock is held
 * - ConsolidationEngine: always releases lock in finally (even on error)
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivationEngine } from "../src/activation/activate";
import { ConsolidationEngine } from "../src/consolidation/consolidate";
import { KnowledgeDB } from "../src/db/sqlite/index";
import { ServerStateDB } from "../src/db/state/index";

// ── ServerStateDB lock ────────────────────────────────────────────────────────
// The consolidation lock lives on IServerStateDB (ServerStateDB), not on the
// knowledge stores (KnowledgeDB / PostgresKnowledgeDB).

describe("ServerStateDB.tryAcquireConsolidationLock", () => {
	let tempDir: string;
	let serverStateDb: ServerStateDB;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ks-lock-test-"));
		serverStateDb = new ServerStateDB(join(tempDir, "state.db"));
	});

	afterEach(async () => {
		await serverStateDb.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("first acquire returns true", async () => {
		expect(await serverStateDb.tryAcquireConsolidationLock()).toBe(true);
	});

	it("second acquire while held returns false", async () => {
		await serverStateDb.tryAcquireConsolidationLock();
		expect(await serverStateDb.tryAcquireConsolidationLock()).toBe(false);
	});

	it("acquire succeeds again after release", async () => {
		await serverStateDb.tryAcquireConsolidationLock();
		await serverStateDb.releaseConsolidationLock();
		expect(await serverStateDb.tryAcquireConsolidationLock()).toBe(true);
	});

	it("releaseConsolidationLock is idempotent when not held", async () => {
		// Should not throw
		await expect(
			serverStateDb.releaseConsolidationLock(),
		).resolves.toBeUndefined();
	});
});

// ── ConsolidationEngine lock integration ─────────────────────────────────────

describe("ConsolidationEngine.consolidate() lock behaviour", () => {
	let tempDir: string;
	let db: KnowledgeDB;
	let serverStateDb: ServerStateDB;
	let engine: ConsolidationEngine;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ks-engine-lock-test-"));
		db = new KnowledgeDB(join(tempDir, "test.db"));
		serverStateDb = new ServerStateDB(join(tempDir, "state.db"));
		const activation = new ActivationEngine(db);
		engine = new ConsolidationEngine(db, serverStateDb, activation, [], null);
	});

	afterEach(async () => {
		mock.restore();
		await db.close();
		await serverStateDb.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns zero result immediately when lock is already held", async () => {
		// Pre-acquire the lock on serverStateDb — that's where ConsolidationEngine
		// actually calls tryAcquireConsolidationLock().
		await serverStateDb.tryAcquireConsolidationLock();

		const result = await engine.consolidate();

		expect(result.sessionsProcessed).toBe(0);
		expect(result.entriesCreated).toBe(0);
		expect(result.duration).toBe(0);
	});

	it("releases lock after successful consolidation", async () => {
		// Mock _consolidate to return a minimal result without doing real work
		spyOn(
			engine as unknown as { _consolidate: () => Promise<unknown> },
			"_consolidate",
		).mockResolvedValue({
			sessionsProcessed: 0,
			segmentsProcessed: 0,
			entriesCreated: 0,
			entriesUpdated: 0,
			entriesArchived: 0,
			conflictsDetected: 0,
			conflictsResolved: 0,
			duration: 1,
		});

		await engine.consolidate();

		// Verify lock is released on serverStateDb (that's where ConsolidationEngine acquires it)
		const lockAcquired = await serverStateDb.tryAcquireConsolidationLock();
		expect(lockAcquired).toBe(true);
		await serverStateDb.releaseConsolidationLock();
	});

	it("releases lock even when _consolidate throws", async () => {
		spyOn(
			engine as unknown as { _consolidate: () => Promise<unknown> },
			"_consolidate",
		).mockRejectedValue(new Error("Simulated LLM failure"));

		await expect(engine.consolidate()).rejects.toThrow("Simulated LLM failure");

		// Lock must be released despite the throw
		const lockAcquired = await serverStateDb.tryAcquireConsolidationLock();
		expect(lockAcquired).toBe(true);
		await serverStateDb.releaseConsolidationLock();
	});
});
