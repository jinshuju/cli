import { readFileSync } from 'node:fs';

/**
 * Read from package.json, not restated here. A release bumps that file and
 * nothing else, so a constant reports the previous version from the moment it
 * is published — 0.1.1 shipped saying 0.1.0.
 */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
