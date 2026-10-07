/*
 * Diagnostics on stderr only: in stdio MCP, stdout carries the protocol and
 * nothing else. One JSON line per event, with the tool name, outcome,
 * duration and public resource IDs — never arguments, file contents, artifact
 * content, signed URLs or the API key.
 */

export type LogSink = (line: string) => void;

export interface Logger {
  event(name: string, fields: Readonly<Record<string, unknown>>): void;
}

/** Public Auvryn IDs (`prj_…`, `job_…`) among a tool's arguments; nothing else is logged. */
export function publicIds(args: unknown): Record<string, string> {
  if (typeof args !== 'object' || args === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        key.endsWith('Id') &&
        key !== 'idempotencyKey' &&
        typeof value === 'string' &&
        /^[a-z]+_[0-9a-z]{26}$/.test(value),
    ),
  );
}

export function createLogger(sink: LogSink = (line) => process.stderr.write(line)): Logger {
  return {
    event(name, fields) {
      sink(
        `${JSON.stringify({ time: new Date().toISOString(), service: 'auvryn-mcp', event: name, ...fields })}\n`,
      );
    },
  };
}
