/**
 * Database module entry point.
 *
 * Re-exports the IKnowledgeDB interface and the two DB implementations.
 * Use StoreRegistry (src/db/store-registry.ts) to create DB instances —
 * it reads store configuration from config.jsonc and initializes all stores.
 */

export type { IKnowledgeDB } from "./interface.js";
export { KnowledgeDB } from "./sqlite/index.js";
export { PostgresKnowledgeDB } from "./postgres/index.js";
