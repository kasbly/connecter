import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditConfig } from '../config/config.types.js';

const AUDIT_READ_CHUNK_SIZE = 64 * 1024;
export const AUDIT_QUERY_COUNT_LIMIT = 1_000;

export interface AuditEntry {
  ts: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  apiKey: string;
  status: number;
  items: number;
  ms: number;
  ip: string;
}

export interface AuditQueryOptions {
  page: number;
  pageSize: number;
  since?: string;
}

export class AuditService {
  private readonly config: AuditConfig;
  private readonly logger?: Pick<FastifyBaseLogger, 'warn'>;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastPruneMs = 0;

  constructor(config: AuditConfig, logger?: Pick<FastifyBaseLogger, 'warn'>) {
    this.config = config;
    this.logger = logger;
    if (config.enabled) {
      const dir = dirname(config.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  log(entry: AuditEntry): void {
    if (!this.config.enabled) return;

    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.rotateIfNeeded();
        const line = JSON.stringify(entry) + '\n';
        await appendFile(this.config.filePath, line, 'utf-8');
      })
      .catch((error: unknown) => {
        this.logger?.warn(
          { err: error, filePath: this.config.filePath },
          'Failed to append audit log',
        );
      });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async query(
    options: AuditQueryOptions,
  ): Promise<{ entries: AuditEntry[]; total: number; totalIsCapped: boolean }> {
    if (!this.config.enabled) {
      return { entries: [], total: 0, totalIsCapped: false };
    }

    await this.flush();
    if (!existsSync(this.config.filePath)) {
      return { entries: [], total: 0, totalIsCapped: false };
    }

    const offset = (options.page - 1) * options.pageSize;
    const entries: AuditEntry[] = [];
    let total = 0;
    let scanned = 0;
    let totalIsCapped = false;

    const collect = (line: Buffer): void => {
      if (line.length === 0) return;
      scanned++;
      if (scanned >= AUDIT_QUERY_COUNT_LIMIT) totalIsCapped = true;
      try {
        const entry = JSON.parse(line.toString('utf8')) as AuditEntry;
        if (options.since && entry.ts < options.since) return;

        if (total >= offset && entries.length < options.pageSize) {
          entries.push(entry);
        }
        total++;
      } catch {
        // Skip malformed lines
      }
    };

    const file = await open(this.config.filePath, 'r');
    try {
      const { size } = await file.stat();
      let position = size;
      let remainder = Buffer.alloc(0);

      while (position > 0) {
        const bytesToRead = Math.min(AUDIT_READ_CHUNK_SIZE, position);
        position -= bytesToRead;

        const chunk = Buffer.allocUnsafe(bytesToRead);
        let bytesRead = 0;
        while (bytesRead < bytesToRead) {
          const result = await file.read(
            chunk,
            bytesRead,
            bytesToRead - bytesRead,
            position + bytesRead,
          );
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        const data =
          remainder.length === 0
            ? chunk.subarray(0, bytesRead)
            : Buffer.concat([chunk.subarray(0, bytesRead), remainder]);

        let lineEnd = data.length;
        for (let index = data.length - 1; index >= 0; index--) {
          if (data[index] !== 0x0a) continue;
          collect(data.subarray(index + 1, lineEnd));
          lineEnd = index;
          if (totalIsCapped) break;
        }
        if (totalIsCapped) break;
        remainder = Buffer.from(data.subarray(0, lineEnd));
      }

      if (!totalIsCapped) collect(remainder);
    } finally {
      await file.close();
    }

    return { entries, total, totalIsCapped };
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stats = await stat(this.config.filePath);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB >= this.config.maxFileSizeMB) {
        const dir = dirname(this.config.filePath);
        const base = basename(this.config.filePath);

        // Shift existing rotated files
        for (let i = 9; i >= 1; i--) {
          const from = join(dir, `${base}.${i}`);
          const to = join(dir, `${base}.${i + 1}`);
          try {
            await rename(from, to);
          } catch (error) {
            if (!isMissingFileError(error)) throw error;
          }
        }

        await rename(this.config.filePath, join(dir, `${base}.1`));
      }
    } catch {
      // Rotation failures must not prevent audit appends.
    }

    // Retention is time-based, so it must not depend on a size-triggered rotation.
    const now = Date.now();
    if (now - this.lastPruneMs > 60 * 60 * 1000) {
      this.lastPruneMs = now;
      await this.pruneOldFiles();
    }
  }

  private async pruneOldFiles(): Promise<void> {
    const dir = dirname(this.config.filePath);
    const base = basename(this.config.filePath);
    const maxAgeMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file.startsWith(base + '.') && file !== base) {
          const filePath = join(dir, file);
          const stats = await stat(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            await unlink(filePath);
          }
        }
      }
    } catch {
      // Silently ignore prune errors
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
