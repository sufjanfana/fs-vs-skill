import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Load-bearing: removeEmptyConfigDir's path-prefix guard refuses anything not under this.
const PREFIX = '/tmp/empty_claude_config_';

export async function makeEmptyConfigDir(): Promise<string> {
  const dir = `${PREFIX}${randomUUID()}`;
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeEmptyConfigDir(dir: string): Promise<void> {
  if (!dir.startsWith(PREFIX)) {
    throw new Error(`refusing to remove '${dir}': not under ${PREFIX}`);
  }
  // Retry: ENOTEMPTY race vs the SDK telemetry/session writer flushing into
  // $CLAUDE_CONFIG_DIR/projects/* during cleanup.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
