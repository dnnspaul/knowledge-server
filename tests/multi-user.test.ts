import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { resolveUserId } from "../src/config-file";

describe("resolveUserId", () => {
	const envKey = "KNOWLEDGE_USER_ID";
	let originalValue: string | undefined;

	beforeEach(() => {
		originalValue = process.env[envKey];
		delete process.env[envKey];
	});

	afterEach(() => {
		if (originalValue !== undefined) {
			process.env[envKey] = originalValue;
		} else {
			delete process.env[envKey];
		}
	});

	it("returns KNOWLEDGE_USER_ID env var when set", () => {
		process.env[envKey] = "alice";
		expect(resolveUserId()).toBe("alice");
	});

	it("env var takes precedence over config userId", () => {
		process.env[envKey] = "from-env";
		expect(resolveUserId("from-config")).toBe("from-env");
	});

	it("uses config userId when env var is absent", () => {
		expect(resolveUserId("from-config")).toBe("from-config");
	});

	it("falls back to hostname when neither env nor config", () => {
		// Spy to ensure a non-empty hostname is returned
		const hostnameSpy = spyOn(os, "hostname").mockReturnValue("test-machine");
		const result = resolveUserId();
		expect(result).toBe("test-machine");
		hostnameSpy.mockRestore();
	});

	it("returns 'default' when hostname is empty and no other source is set", () => {
		const hostnameSpy = spyOn(os, "hostname").mockReturnValue("");
		const result = resolveUserId();
		expect(result).toBe("default");
		hostnameSpy.mockRestore();
	});
});

// source_cursor and per-user cursor isolation removed in v13 (daemon-only architecture).
// consolidation drains all pending_episodes regardless of origin.
