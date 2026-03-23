import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONFIG_PATH, DEFAULT_SQLITE_PATH } from "../config-file.js";

/**
 * `knowledge-server migrate-config`
 *
 * Generates ~/.config/knowledge-server/config.jsonc from legacy environment
 * variables (POSTGRES_CONNECTION_URI, KNOWLEDGE_DB_PATH, KNOWLEDGE_USER_ID).
 *
 * Safe to run multiple times — exits early if config.jsonc already exists.
 */
export function runMigrateConfig(): void {
	if (existsSync(DEFAULT_CONFIG_PATH)) {
		console.log(`Config file already exists at ${DEFAULT_CONFIG_PATH}`);
		console.log("Remove it first if you want to regenerate it.");
		process.exit(0);
	}

	const pgUri = process.env.POSTGRES_CONNECTION_URI;
	const sqlitePath = process.env.KNOWLEDGE_DB_PATH ?? DEFAULT_SQLITE_PATH;
	const userId = process.env.KNOWLEDGE_USER_ID?.trim();

	let storeBlock: string;
	let envVarsToRemove: string[];

	if (pgUri) {
		// Use JSON.stringify so special characters in the URI (quotes, backslashes,
		// non-ASCII) are properly escaped and the output is always valid JSONC.
		storeBlock = `    {
      "id": "main",
      "kind": "postgres",
      // URI from POSTGRES_CONNECTION_URI — you can also set STORE_MAIN_URI env var instead
      "uri": ${JSON.stringify(pgUri)},
      "writable": true
    }`;
		envVarsToRemove = ["POSTGRES_CONNECTION_URI"];
	} else {
		// SQLite store
		storeBlock = `    {
      "id": "main",
      "kind": "sqlite",
      "path": ${JSON.stringify(sqlitePath)},
      "writable": true
    }`;
		envVarsToRemove =
			sqlitePath !== DEFAULT_SQLITE_PATH ? ["KNOWLEDGE_DB_PATH"] : [];
	}

	// userId block — written only when KNOWLEDGE_USER_ID is set, so the generated
	// file reflects the actual identity rather than defaulting to hostname.
	const userIdBlock = userId
		? `
  // userId: stable identifier for this user/machine in shared-DB setups.
  // Scopes the consolidation cursor so multiple users sharing the same DB advance independently.
  // From KNOWLEDGE_USER_ID env var — you can remove that var now that it is captured here.
  "userId": ${JSON.stringify(userId)},`
		: `
  // userId: stable identifier for this user/machine in shared-DB setups.
  // Defaults to the OS hostname when unset. Set explicitly to avoid surprises if the
  // hostname changes (e.g. after a OS reinstall).
  // "userId": "your-name-or-machine-id",`;

	if (userId) {
		envVarsToRemove = [...envVarsToRemove, "KNOWLEDGE_USER_ID"];
	}

	const content = `{
  // Knowledge Server configuration
  // See: https://github.com/MAnders333/knowledge-server#configuration
  //
  // stores: list of knowledge databases
  //   - at least one store must have "writable": true (receives consolidation writes)
  //   - multiple writable stores are allowed when domains[] are configured for routing
  //   - all stores are used for activation reads (fan-out)
  "stores": [
${storeBlock}
  ],
${userIdBlock}

  // domains and projects: optional routing config for multi-store setups.
  // See docs for examples.
  "domains": [],
  "projects": []
}
`;

	// Ensure directory exists
	mkdirSync(dirname(DEFAULT_CONFIG_PATH), { recursive: true });
	writeFileSync(DEFAULT_CONFIG_PATH, content, "utf8");

	console.log(`✓ Written to ${DEFAULT_CONFIG_PATH}`);
	console.log("");

	if (pgUri) {
		console.warn(
			"Warning: config.jsonc contains your database password in plaintext.\n" +
				"  Consider moving it to the STORE_MAIN_URI environment variable instead.",
		);
		console.log("");
	}

	if (envVarsToRemove.length > 0) {
		console.log(
			`You can now remove the following from your .env file:\n  ${envVarsToRemove.join("\n  ")}`,
		);
		console.log("");
	}

	console.log(
		"To add more stores (e.g. a shared team database), edit the config file.",
	);
	console.log("See the docs for full configuration options.");
}
