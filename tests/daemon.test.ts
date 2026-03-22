/**
 * Tests for the episode uploader daemon.
 *
 * Tests cover:
 * - pending_episodes DB operations (insert, fetch, delete)
 * - daemon_cursor operations (get, update, local-only semantics)
 * - EpisodeUploader core logic (upload, cursor advance, dedup)
 * - PendingEpisodesReader (prepare, getCandidateSessions, getNewEpisodes, afterConsolidated)
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeUploader } from "../src/daemon/uploader";
import { KnowledgeDB } from "../src/db/database";
import { PendingEpisodesReader } from "../src/consolidation/readers/pending";
import type { IEpisodeReader, PendingEpisode } from "../src/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makePendingEpisode(
	overrides: Partial<PendingEpisode> = {},
): PendingEpisode {
	const now = Date.now();
	return {
		id: "ep-test-1",
		userId: "alice",
		source: "opencode",
		sessionId: "session-abc",
		startMessageId: "msg-start",
		endMessageId: "msg-end",
		sessionTitle: "Test Session",
		projectName: "my-project",
		directory: "/home/alice/work/project",
		content: "User asked about TypeScript types.",
		contentType: "messages",
		timeCreated: now - 5000,
		maxMessageTime: now,
		approxTokens: 100,
		uploadedAt: now,
		...overrides,
	};
}

function makeMockReader(
	source: string,
	sessions: Array<{ id: string; maxMessageTime: number }>,
	episodes: import("../src/types").Episode[],
): IEpisodeReader {
	return {
		source,
		getCandidateSessions: () => sessions,
		countNewSessions: () => sessions.length,
		getNewEpisodes: () => episodes,
		close: () => {},
	};
}

// ── setup ─────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: KnowledgeDB;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "ks-daemon-test-"));
	db = new KnowledgeDB(join(tempDir, "test.db"));
});

afterEach(async () => {
	mock.restore();
	await db.close();
	rmSync(tempDir, { recursive: true, force: true });
});

// ── pending_episodes DB operations ────────────────────────────────────────────

describe("pending_episodes DB operations", () => {
	it("inserts and retrieves pending episodes", async () => {
		const ep = makePendingEpisode();
		await db.insertPendingEpisode(ep);

		const rows = await db.getPendingEpisodes("opencode", "alice", 0);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("ep-test-1");
		expect(rows[0].userId).toBe("alice");
		expect(rows[0].content).toBe("User asked about TypeScript types.");
	});

	it("filters by source and userId", async () => {
		await db.insertPendingEpisode(
			makePendingEpisode({ id: "ep-1", source: "opencode", userId: "alice" }),
		);
		await db.insertPendingEpisode(
			makePendingEpisode({
				id: "ep-2",
				source: "claude-code",
				userId: "alice",
			}),
		);
		await db.insertPendingEpisode(
			makePendingEpisode({ id: "ep-3", source: "opencode", userId: "bob" }),
		);

		const aliceOpenCode = await db.getPendingEpisodes("opencode", "alice", 0);
		expect(aliceOpenCode).toHaveLength(1);
		expect(aliceOpenCode[0].id).toBe("ep-1");

		const bob = await db.getPendingEpisodes("opencode", "bob", 0);
		expect(bob).toHaveLength(1);
		expect(bob[0].id).toBe("ep-3");
	});

	it("filters by afterMaxMessageTime", async () => {
		const now = Date.now();
		await db.insertPendingEpisode(
			makePendingEpisode({ id: "old", maxMessageTime: now - 10000 }),
		);
		await db.insertPendingEpisode(
			makePendingEpisode({ id: "new", maxMessageTime: now }),
		);

		const rows = await db.getPendingEpisodes("opencode", "alice", now - 5000);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("new");
	});

	it("is idempotent — duplicate inserts are ignored", async () => {
		const ep = makePendingEpisode();
		await db.insertPendingEpisode(ep);
		await db.insertPendingEpisode(ep); // same id

		const rows = await db.getPendingEpisodes("opencode", "alice", 0);
		expect(rows).toHaveLength(1);
	});

	it("deletes episodes by id", async () => {
		await db.insertPendingEpisode(makePendingEpisode({ id: "ep-1" }));
		await db.insertPendingEpisode(makePendingEpisode({ id: "ep-2" }));

		await db.deletePendingEpisodes(["ep-1"]);

		const rows = await db.getPendingEpisodes("opencode", "alice", 0);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("ep-2");
	});

	it("deletePendingEpisodes is a no-op on empty array", async () => {
		await db.insertPendingEpisode(makePendingEpisode());
		await db.deletePendingEpisodes([]);
		const rows = await db.getPendingEpisodes("opencode", "alice", 0);
		expect(rows).toHaveLength(1);
	});
});

// ── daemon_cursor ─────────────────────────────────────────────────────────────

describe("daemon_cursor operations", () => {
	it("returns zero-state cursor for unknown source", async () => {
		const cursor = await db.getDaemonCursor("opencode");
		expect(cursor.source).toBe("opencode");
		expect(cursor.lastMessageTimeCreated).toBe(0);
		expect(cursor.lastUploadedAt).toBe(0);
	});

	it("updates and retrieves cursor", async () => {
		await db.updateDaemonCursor("opencode", {
			lastMessageTimeCreated: 12345,
			lastUploadedAt: 67890,
		});
		const cursor = await db.getDaemonCursor("opencode");
		expect(cursor.lastMessageTimeCreated).toBe(12345);
		expect(cursor.lastUploadedAt).toBe(67890);
	});

	it("cursors are independent per source", async () => {
		await db.updateDaemonCursor("opencode", { lastMessageTimeCreated: 1000 });
		await db.updateDaemonCursor("claude-code", {
			lastMessageTimeCreated: 9999,
		});

		const oc = await db.getDaemonCursor("opencode");
		const cc = await db.getDaemonCursor("claude-code");
		expect(oc.lastMessageTimeCreated).toBe(1000);
		expect(cc.lastMessageTimeCreated).toBe(9999);
	});
});

// ── EpisodeUploader ───────────────────────────────────────────────────────────

describe("EpisodeUploader.upload", () => {
	it("uploads episodes to pending_episodes and advances daemon cursor", async () => {
		const now = Date.now();
		const reader = makeMockReader(
			"opencode",
			[{ id: "session-1", maxMessageTime: now }],
			[
				{
					sessionId: "session-1",
					startMessageId: "msg-a",
					endMessageId: "msg-b",
					sessionTitle: "Test",
					projectName: "project",
					directory: "/home/alice/work",
					timeCreated: now - 1000,
					maxMessageTime: now,
					content: "session content",
					contentType: "messages",
					approxTokens: 50,
				},
			],
		);

		const uploader = new EpisodeUploader([reader], db, db, "alice");
		const result = await uploader.upload();

		expect(result.episodesUploaded).toBe(1);
		expect(result.sessionsProcessed).toBe(1);

		const pending = await db.getPendingEpisodes("opencode", "alice", 0);
		expect(pending).toHaveLength(1);
		expect(pending[0].sessionId).toBe("session-1");
		expect(pending[0].userId).toBe("alice");

		const cursor = await db.getDaemonCursor("opencode");
		expect(cursor.lastMessageTimeCreated).toBeGreaterThan(0);
	});

	it("does not re-upload already-pending episodes", async () => {
		const now = Date.now();
		// Pre-insert the episode as already pending
		await db.insertPendingEpisode(
			makePendingEpisode({
				id: "pre-existing",
				source: "opencode",
				userId: "alice",
				sessionId: "session-1",
				startMessageId: "msg-a",
				endMessageId: "msg-b",
				maxMessageTime: now,
			}),
		);

		const reader = makeMockReader(
			"opencode",
			[{ id: "session-1", maxMessageTime: now }],
			[
				{
					sessionId: "session-1",
					startMessageId: "msg-a",
					endMessageId: "msg-b",
					sessionTitle: "Test",
					projectName: "project",
					directory: "/home/alice/work",
					timeCreated: now - 1000,
					maxMessageTime: now,
					content: "session content",
					contentType: "messages",
					approxTokens: 50,
				},
			],
		);

		const uploader = new EpisodeUploader([reader], db, db, "alice");
		const result = await uploader.upload();

		// Should not upload again — already in pending_episodes
		expect(result.episodesUploaded).toBe(0);
		const pending = await db.getPendingEpisodes("opencode", "alice", 0);
		expect(pending).toHaveLength(1);
		expect(pending[0].id).toBe("pre-existing");
	});

	it("skips a failed reader and continues with others", async () => {
		const now = Date.now();
		const failingReader: IEpisodeReader = {
			source: "opencode",
			getCandidateSessions: () => {
				throw new Error("DB read failed");
			},
			countNewSessions: () => 0,
			getNewEpisodes: () => [],
			close: () => {},
		};
		const workingReader = makeMockReader(
			"claude-code",
			[{ id: "session-cc-1", maxMessageTime: now }],
			[
				{
					sessionId: "session-cc-1",
					startMessageId: "msg-x",
					endMessageId: "msg-y",
					sessionTitle: "CC Session",
					projectName: "project",
					directory: "/home/alice",
					timeCreated: now - 1000,
					maxMessageTime: now,
					content: "claude content",
					contentType: "messages",
					approxTokens: 30,
				},
			],
		);

		const uploader = new EpisodeUploader(
			[failingReader, workingReader],
			db,
			db,
			"alice",
		);
		const result = await uploader.upload();

		// opencode failed but claude-code succeeded
		expect(result.episodesUploaded).toBe(1);
		const pending = await db.getPendingEpisodes("claude-code", "alice", 0);
		expect(pending).toHaveLength(1);
	});
});

// ── PendingEpisodesReader ─────────────────────────────────────────────────────

describe("PendingEpisodesReader", () => {
	it("prepare loads candidates and getNewEpisodes returns episodes", async () => {
		const now = Date.now();
		await db.insertPendingEpisode(
			makePendingEpisode({
				id: "ep-r1",
				source: "opencode",
				userId: "alice",
				sessionId: "session-r1",
				maxMessageTime: now,
			}),
		);

		const reader = new PendingEpisodesReader("opencode", "alice", db);
		await reader.prepare(0);

		const candidates = reader.getCandidateSessions(0);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].id).toBe("session-r1");

		const episodes = reader.getNewEpisodes(["session-r1"], new Map());
		expect(episodes).toHaveLength(1);
		expect(episodes[0].sessionId).toBe("session-r1");
	});

	it("source name is prefixed with 'pending:'", () => {
		const reader = new PendingEpisodesReader("opencode", "alice", db);
		expect(reader.source).toBe("pending:opencode");
	});

	it("getNewEpisodes excludes already-processed ranges", async () => {
		const now = Date.now();
		await db.insertPendingEpisode(
			makePendingEpisode({
				id: "ep-proc",
				source: "opencode",
				userId: "alice",
				sessionId: "session-p1",
				startMessageId: "msg-start",
				endMessageId: "msg-end",
				maxMessageTime: now,
			}),
		);

		const reader = new PendingEpisodesReader("opencode", "alice", db);
		await reader.prepare(0);

		// Mark as already processed
		const processedRanges = new Map([
			[
				"session-p1",
				[{ startMessageId: "msg-start", endMessageId: "msg-end" }],
			],
		]);

		const episodes = reader.getNewEpisodes(["session-p1"], processedRanges);
		expect(episodes).toHaveLength(0);
	});

	it("afterConsolidated deletes processed rows from pending_episodes", async () => {
		const now = Date.now();
		await db.insertPendingEpisode(
			makePendingEpisode({
				id: "ep-del-1",
				source: "opencode",
				userId: "alice",
				sessionId: "session-del-1",
				maxMessageTime: now,
			}),
		);
		await db.insertPendingEpisode(
			makePendingEpisode({
				id: "ep-del-2",
				source: "opencode",
				userId: "alice",
				sessionId: "session-del-2",
				maxMessageTime: now,
			}),
		);

		const reader = new PendingEpisodesReader("opencode", "alice", db);
		await reader.prepare(0);

		await reader.afterConsolidated(["session-del-1"]);

		const remaining = await db.getPendingEpisodes("opencode", "alice", 0);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("ep-del-2");
	});
});
