import { randomBytes } from 'node:crypto';

/**
 * The idempotency key of a tool call that did not bring one: generated once
 * per invocation (so the SDK's retries of that call reuse it) and returned to
 * the agent, which reuses it if it retries. `mcp_` + 144 random bits, URL-safe:
 * recognizably the MCP server's, and never shaped like an internal UUID.
 */
export function idempotencyKeyFor(provided: string | undefined): string {
  return provided ?? `mcp_${randomBytes(18).toString('base64url')}`;
}
