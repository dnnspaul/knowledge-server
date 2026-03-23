/**
 * Database module entry point.
 *
 * Re-exports interfaces and implementations.
 * Use StoreRegistry (src/db/store-registry.ts) to create DB instances —
 * it reads store configuration from config.jsonc and initializes all stores.
 */

export type { IServerStateDB, IKnowledgeStore } from "./interface.js";
export { KnowledgeDB } from "./sqlite/index.js";
export { PostgresKnowledgeDB } from "./postgres/index.js";
export {
	ServerStateDB,
	DEFAULT_SERVER_STATE_PATH,
} from "./state/index.js";
