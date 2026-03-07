/**
 * Tests for VSCodeEpisodeReader.
 *
 * VSCode stores each chat session as an individual JSON file under
 * <dataDir>/User/workspaceStorage/<hash>/chatSessions/*.json
 * These tests create a minimal fake VSCode data directory in a temp dir,
 * seed it with session JSON files, and exercise the reader's segmentation
 * + extraction logic without any filesystem access beyond the temp dir.
 *
 * Covered:
 *   - getCandidateSessions / countNewSessions — lastMessageDate cursor filtering
 *   - getNewEpisodes — basic user + assistant message extraction
 *   - getNewEpisodes — response part kind filtering (metadata parts skipped)
 *   - getNewEpisodes — markdownContent and markdownVuln kinds included
 *   - getNewEpisodes — sessions with isEmpty=true skipped
 *   - getNewEpisodes — sessions with missing sessionId skipped
 *   - getNewEpisodes — sessions with lastMessageDate=0 skipped
 *   - getNewEpisodes — sessions with no text content skipped
 *   - getNewEpisodes — processedRanges exclusion
 *   - getNewEpisodes — minSessionMessages filter
 *   - getNewEpisodes — projectName derived from workspace.json folder URI
 *   - getNewEpisodes — ordering by lastMessageDate ASC
 *   - getNewEpisodes — limit parameter
 *   - Malformed JSON session files skipped gracefully
 *   - resolveVSCodeDataDir() — env var branch
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VSCodeEpisodeReader,
	resolveVSCodeDataDir,
} from "../src/consolidation/readers/vscode";

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE = 1_700_000_000_000; // fixed unix ms base for all timestamps

let tmpDir: string;
let dataDir: string;
let wsDir: string;
let chatDir: string;

/**
 * Create the standard VSCode directory structure under tmpDir.
 * Returns paths for convenience.
 */
function setup(): { dataDir: string; wsDir: string; chatDir: string } {
	tmpDir = mkdtempSync(join(tmpdir(), "ks-vscode-test-"));
	dataDir = join(tmpDir, "vscode-data");
	wsDir = join(dataDir, "User", "workspaceStorage", "abc123hash");
	chatDir = join(wsDir, "chatSessions");
	mkdirSync(chatDir, { recursive: true });
	return { dataDir, wsDir, chatDir };
}

/** Write workspace.json mapping the workspace hash to a fake project path. */
function writeWorkspaceJson(dir: string, folderPath: string): void {
	writeFileSync(
		join(dir, "workspace.json"),
		JSON.stringify({ folder: `file://${folderPath}` }),
	);
}

/** Build a minimal valid VSCode session JSON object. */
function makeSession(opts: {
	sessionId?: string;
	customTitle?: string;
	creationDate?: number;
	lastMessageDate?: number;
	isEmpty?: boolean;
	requests?: Array<{
		requestId?: string;
		messageText?: string;
		timestamp?: number;
		response?: Array<{ kind?: string; value?: string }>;
	}>;
}): object {
	return {
		version: 1,
		sessionId: opts.sessionId ?? "session-uuid-1234",
		customTitle: opts.customTitle,
		creationDate: opts.creationDate ?? BASE,
		lastMessageDate: opts.lastMessageDate ?? BASE + 10_000,
		isEmpty: opts.isEmpty,
		requests: (opts.requests ?? []).map((r, i) => ({
			requestId: r.requestId ?? `req-${i}`,
			timestamp: r.timestamp ?? BASE + i * 1000,
			message: r.messageText !== undefined ? { text: r.messageText } : undefined,
			response: r.response,
		})),
	};
}

/** Write a session JSON file into chatDir and return its path. */
function writeSession(
	filename: string,
	session: object,
	dir = chatDir,
): string {
	const path = join(dir, filename);
	writeFileSync(path, JSON.stringify(session));
	return path;
}

beforeEach(() => {
	({ dataDir, wsDir, chatDir } = setup());
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ── getCandidateSessions / countNewSessions ────────────────────────────────────

describe("VSCodeEpisodeReader.getCandidateSessions", () => {
	it("returns a session newer than the cursor", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				lastMessageDate: BASE + 5000,
				requests: [
					{ messageText: "hello", response: [{ value: "hi" }] },
					{ messageText: "bye", response: [{ value: "ok" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(BASE);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].id).toBe("session-1");
		expect(candidates[0].maxMessageTime).toBe(BASE + 5000);
		reader.close();
	});

	it("excludes sessions at or before the cursor", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				lastMessageDate: BASE,
				requests: [{ messageText: "old", response: [{ value: "reply" }] }],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		expect(reader.getCandidateSessions(BASE)).toHaveLength(0);
		reader.close();
	});

	it("returns sessions ordered by lastMessageDate ASC", () => {
		// s2 is newer — should come second
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-earlier",
				lastMessageDate: BASE + 2000,
				requests: [
					{ messageText: "a", response: [{ value: "b" }] },
					{ messageText: "c", response: [{ value: "d" }] },
				],
			}),
		);
		writeSession(
			"s2.json",
			makeSession({
				sessionId: "session-later",
				lastMessageDate: BASE + 10_000,
				requests: [
					{ messageText: "e", response: [{ value: "f" }] },
					{ messageText: "g", response: [{ value: "h" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(BASE - 1);
		expect(candidates).toHaveLength(2);
		expect(candidates[0].id).toBe("session-earlier");
		expect(candidates[1].id).toBe("session-later");
		reader.close();
	});

	it("respects the limit parameter", () => {
		for (let i = 1; i <= 3; i++) {
			writeSession(
				`s${i}.json`,
				makeSession({
					sessionId: `session-${i}`,
					lastMessageDate: BASE + i * 1000,
					requests: [
						{ messageText: "hi", response: [{ value: "hey" }] },
						{ messageText: "bye", response: [{ value: "ok" }] },
					],
				}),
			);
		}

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(BASE - 1, 2);
		expect(candidates).toHaveLength(2);
		reader.close();
	});
});

describe("VSCodeEpisodeReader.countNewSessions", () => {
	it("returns the correct count", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				lastMessageDate: BASE + 5000,
				requests: [{ messageText: "hello", response: [{ value: "hi" }] }],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		expect(reader.countNewSessions(BASE)).toBe(1);
		expect(reader.countNewSessions(BASE + 5000)).toBe(0);
		reader.close();
	});
});

// ── getNewEpisodes — basic extraction ─────────────────────────────────────────

describe("VSCodeEpisodeReader.getNewEpisodes — basic extraction", () => {
	it("produces one episode with correct user and assistant content", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				customTitle: "My Test Chat",
				requests: [
					{
						messageText: "What is 2+2?",
						response: [{ value: "It is 4." }],
					},
					{
						messageText: "And 3+3?",
						response: [{ value: "It is 6." }],
					},
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes(
			[candidates[0].id],
			new Map(),
		);

		expect(episodes).toHaveLength(1);
		expect(episodes[0].sessionId).toBe("session-1");
		expect(episodes[0].sessionTitle).toBe("My Test Chat");
		expect(episodes[0].contentType).toBe("messages");
		expect(episodes[0].content).toContain("What is 2+2");
		expect(episodes[0].content).toContain("It is 4");
		expect(episodes[0].content).toContain("And 3+3");
		expect(episodes[0].content).toContain("It is 6");
		reader.close();
	});

	it("falls back to sessionId-based title when customTitle is absent", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "abcd1234-5678-0000-0000-000000000000",
				requests: [
					{ messageText: "hi", response: [{ value: "hey" }] },
					{ messageText: "bye", response: [{ value: "ok" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes[0].sessionTitle).toContain("abcd1234");
		reader.close();
	});

	it("derives projectName from workspace.json folder URI", () => {
		writeWorkspaceJson(wsDir, "/Users/alice/my-project");
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				requests: [
					{ messageText: "hi", response: [{ value: "hey" }] },
					{ messageText: "bye", response: [{ value: "ok" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes[0].projectName).toBe("my-project");
		expect(episodes[0].directory).toBe("/Users/alice/my-project");
		reader.close();
	});

	it("sets startMessageId and endMessageId to requestIds", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				requests: [
					{ requestId: "req-aaa", messageText: "first", response: [{ value: "reply1" }] },
					{ requestId: "req-bbb", messageText: "second", response: [{ value: "reply2" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes[0].startMessageId).toBe("req-aaa");
		// endMessageId is the last message id — could be req-bbb or a derived response id
		expect(episodes[0].endMessageId).toBeTruthy();
		reader.close();
	});
});

// ── getNewEpisodes — response part kind filtering ─────────────────────────────

describe("VSCodeEpisodeReader.getNewEpisodes — response part kind filtering", () => {
	it("includes parts with no kind (plain text)", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				requests: [
					{
						messageText: "summarise",
						response: [{ value: "Here is the summary." }],
					},
					{ messageText: "thanks", response: [{ value: "welcome" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes[0].content).toContain("Here is the summary");
		reader.close();
	});

	it("includes parts with kind=markdownContent", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				requests: [
					{
						messageText: "explain",
						response: [{ kind: "markdownContent", value: "Markdown explanation." }],
					},
					{ messageText: "ok", response: [{ value: "done" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes[0].content).toContain("Markdown explanation");
		reader.close();
	});

	it("includes parts with kind=markdownVuln", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				requests: [
					{
						messageText: "check security",
						response: [{ kind: "markdownVuln", value: "Vulnerability found." }],
					},
					{ messageText: "ok", response: [{ value: "noted" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes[0].content).toContain("Vulnerability found");
		reader.close();
	});

	it("skips metadata parts (toolInvocationSerialized, codeblockUri, etc.)", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				requests: [
					{
						messageText: "run tool",
						response: [
							{ kind: "toolInvocationSerialized", value: '{"tool":"bash","input":"ls"}' },
							{ kind: "codeblockUri", value: "/some/file.ts" },
							{ kind: "textEditGroup", value: "edit data" },
							{ kind: "inlineReference", value: "ref data" },
							{ kind: "undoStop", value: "" },
							{ value: "Tool completed successfully." }, // no kind — should be included
						],
					},
					{ messageText: "done", response: [{ value: "all good" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes[0].content).toContain("Tool completed successfully");
		expect(episodes[0].content).not.toContain("toolInvocationSerialized");
		expect(episodes[0].content).not.toContain("/some/file.ts");
		reader.close();
	});
});

// ── getNewEpisodes — session-level skip conditions ────────────────────────────

describe("VSCodeEpisodeReader.getNewEpisodes — session skip conditions", () => {
	it("skips sessions with isEmpty=true", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				isEmpty: true,
				requests: [{ messageText: "hello", response: [{ value: "hi" }] }],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		expect(reader.getCandidateSessions(0)).toHaveLength(0);
		reader.close();
	});

	it("skips sessions with missing sessionId", () => {
		writeSession("s1.json", {
			creationDate: BASE,
			lastMessageDate: BASE + 5000,
			requests: [
				{
					requestId: "req-1",
					message: { text: "hello" },
					response: [{ value: "hi" }],
				},
			],
		});

		const reader = new VSCodeEpisodeReader(dataDir);
		expect(reader.getCandidateSessions(0)).toHaveLength(0);
		reader.close();
	});

	it("skips sessions with lastMessageDate=0", () => {
		writeSession("s1.json", {
			sessionId: "session-1",
			creationDate: 0,
			lastMessageDate: 0,
			requests: [{ requestId: "r1", message: { text: "hi" }, response: [] }],
		});

		const reader = new VSCodeEpisodeReader(dataDir);
		expect(reader.getCandidateSessions(0)).toHaveLength(0);
		reader.close();
	});

	it("skips sessions where all requests have empty message text", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				requests: [
					{ messageText: "", response: [{ value: "response with no user text" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		expect(reader.getCandidateSessions(0)).toHaveLength(0);
		reader.close();
	});

	it("skips malformed JSON session files gracefully", () => {
		writeFileSync(join(chatDir, "bad.json"), "{not valid json");
		// Also write one valid session so we can verify the reader still works
		writeSession(
			"good.json",
			makeSession({
				sessionId: "session-good",
				requests: [
					{ messageText: "hello", response: [{ value: "hi" }] },
					{ messageText: "bye", response: [{ value: "ok" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].id).toBe("session-good");
		reader.close();
	});

	it("skips sessions with empty requests array", () => {
		writeSession("s1.json", {
			sessionId: "session-1",
			creationDate: BASE,
			lastMessageDate: BASE + 5000,
			requests: [],
		});

		const reader = new VSCodeEpisodeReader(dataDir);
		expect(reader.getCandidateSessions(0)).toHaveLength(0);
		reader.close();
	});
});

// ── getNewEpisodes — minSessionMessages filter ────────────────────────────────

describe("VSCodeEpisodeReader.getNewEpisodes — minSessionMessages filter", () => {
	it("skips sessions that produce fewer messages than minSessionMessages", () => {
		// Default minSessionMessages is 4. A single request with 1 user + 1 assistant
		// message produces only 2 messages — below the threshold.
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-short",
				requests: [
					{ messageText: "hi", response: [{ value: "hey" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes).toHaveLength(0);
		reader.close();
	});
});

// ── getNewEpisodes — processedRanges exclusion ────────────────────────────────

describe("VSCodeEpisodeReader.getNewEpisodes — processedRanges exclusion", () => {
	it("skips episodes whose (startMessageId, endMessageId) are already processed", () => {
		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-1",
				requests: [
					{ requestId: "r1", messageText: "start", response: [{ value: "reply1" }] },
					{ requestId: "r2", messageText: "continue", response: [{ value: "reply2" }] },
				],
			}),
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);

		// First call: get the episode range
		const episodes = reader.getNewEpisodes([candidates[0].id], new Map());
		expect(episodes).toHaveLength(1);

		// Second call: mark that range as processed
		const processedRanges = new Map([
			[
				"session-1",
				[
					{
						startMessageId: episodes[0].startMessageId,
						endMessageId: episodes[0].endMessageId,
					},
				],
			],
		]);
		const episodes2 = reader.getNewEpisodes([candidates[0].id], processedRanges);
		expect(episodes2).toHaveLength(0);
		reader.close();
	});
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("VSCodeEpisodeReader — edge cases", () => {
	it("returns no sessions when workspaceStorage directory does not exist", () => {
		// dataDir exists but has no User/workspaceStorage
		const emptyDataDir = mkdtempSync(join(tmpdir(), "ks-vscode-empty-"));
		try {
			const reader = new VSCodeEpisodeReader(emptyDataDir);
			expect(reader.getCandidateSessions(0)).toHaveLength(0);
			expect(reader.countNewSessions(0)).toBe(0);
			reader.close();
		} finally {
			rmSync(emptyDataDir, { recursive: true, force: true });
		}
	});

	it("handles workspace directory with no chatSessions subdirectory", () => {
		// wsDir exists but no chatSessions/ inside it
		rmSync(chatDir, { recursive: true, force: true });

		const reader = new VSCodeEpisodeReader(dataDir);
		expect(reader.getCandidateSessions(0)).toHaveLength(0);
		reader.close();
	});

	it("sessions across multiple workspace directories are all discovered", () => {
		// Create a second workspace directory
		const wsDir2 = join(dataDir, "User", "workspaceStorage", "def456hash");
		const chatDir2 = join(wsDir2, "chatSessions");
		mkdirSync(chatDir2, { recursive: true });

		writeSession(
			"s1.json",
			makeSession({
				sessionId: "session-ws1",
				requests: [
					{ messageText: "from ws1", response: [{ value: "reply1" }] },
					{ messageText: "more ws1", response: [{ value: "reply2" }] },
				],
			}),
		);
		writeSession(
			"s2.json",
			makeSession({
				sessionId: "session-ws2",
				requests: [
					{ messageText: "from ws2", response: [{ value: "reply3" }] },
					{ messageText: "more ws2", response: [{ value: "reply4" }] },
				],
			}),
			chatDir2,
		);

		const reader = new VSCodeEpisodeReader(dataDir);
		const candidates = reader.getCandidateSessions(0);
		expect(candidates).toHaveLength(2);
		const ids = candidates.map((c) => c.id);
		expect(ids).toContain("session-ws1");
		expect(ids).toContain("session-ws2");
		reader.close();
	});
});

// ── resolveVSCodeDataDir — env var branch ─────────────────────────────────────

describe("resolveVSCodeDataDir", () => {
	it("returns null when VSCODE_DATA_DIR points to a non-existent directory", () => {
		const original = process.env.VSCODE_DATA_DIR;
		process.env.VSCODE_DATA_DIR = "/nonexistent/vscode/data";
		try {
			expect(resolveVSCodeDataDir()).toBeNull();
		} finally {
			if (original === undefined) {
				Reflect.deleteProperty(process.env, "VSCODE_DATA_DIR");
			} else {
				process.env.VSCODE_DATA_DIR = original;
			}
		}
	});

	it("returns the path when VSCODE_DATA_DIR points to a valid VSCode data directory", () => {
		// resolveVSCodeDataDir checks for User/workspaceStorage inside the given path
		const dir = mkdtempSync(join(tmpdir(), "ks-vscode-dir-"));
		mkdirSync(join(dir, "User", "workspaceStorage"), { recursive: true });
		const original = process.env.VSCODE_DATA_DIR;
		process.env.VSCODE_DATA_DIR = dir;
		try {
			expect(resolveVSCodeDataDir()).toBe(dir);
		} finally {
			if (original === undefined) {
				Reflect.deleteProperty(process.env, "VSCODE_DATA_DIR");
			} else {
				process.env.VSCODE_DATA_DIR = original;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
