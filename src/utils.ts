/**
 * Extract the `code` property from an unknown thrown value.
 *
 * Node/Bun system errors (ENOENT, EPERM, ESRCH, EADDRINUSE, …) carry a
 * `code` string on the error object. This helper avoids repeating the
 * `(e as { code?: string }).code` inline cast — the preferred pattern in
 * this codebase over `(e as NodeJS.ErrnoException).code` because the project
 * uses `"types": ["bun"]` without `@types/node`.
 */
export function errCode(e: unknown): string | undefined {
	return (e as { code?: string }).code;
}
