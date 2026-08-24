import { existsSync, mkdirSync } from 'node:fs';
import {
  appendFile,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditConfig } from '../config/config.types.js';

const AUDIT_READ_CHUNK_SIZE = 64 * 1024;
export const AUDIT_QUERY_COUNT_LIMIT = 1_000;

function resolveAuditQueryCountLimit(options: AuditQueryOptions): number {
  const offset = (options.page - 1) * options.pageSize;
  // Do not let the count cap hide the requested page, and retain one more entry
  // so a capped total still advertises that there may be a following page.
  return Math.max(AUDIT_QUERY_COUNT_LIMIT, offset + options.pageSize + 1);
}

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

export interface AuditHealth {
  enabled: boolean;
  ok: boolean;
  lastSuccessfulAppendAt?: string;
  error?: string;
}

export class AuditService {
  private readonly config: AuditConfig;
  private readonly logger?: Pick<FastifyBaseLogger, 'warn'>;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastPruneMs = 0;
  private hasWarnedAboutRotationTruncation = false;
  private lastSuccessfulAppendAt: string | undefined;
  private writeError: string | undefined;
  private rotationError: string | undefined;
  private pruneError: string | undefined;

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
        this.lastSuccessfulAppendAt = new Date().toISOString();
        this.writeError = undefined;
      })
      .catch((error: unknown) => {
        this.writeError = errorMessage(error);
        this.logger?.warn(
          { err: error, filePath: this.config.filePath },
          'Failed to append audit log',
        );
      });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  getHealth(): AuditHealth {
    if (!this.config.enabled) return { enabled: false, ok: true };

    const error = this.writeError ?? this.rotationError ?? this.pruneError;
    return {
      enabled: true,
      ok: error === undefined,
      ...(this.lastSuccessfulAppendAt
        ? { lastSuccessfulAppendAt: this.lastSuccessfulAppendAt }
        : {}),
      ...(error ? { error } : {}),
    };
  }

  async query(
    options: AuditQueryOptions,
  ): Promise<{ entries: AuditEntry[]; total: number; totalIsCapped: boolean }> {
    if (!this.config.enabled) {
      return { entries: [], total: 0, totalIsCapped: false };
    }

    await this.flush();
    const offset = (options.page - 1) * options.pageSize;
    const countLimit = resolveAuditQueryCountLimit(options);
    const entries: AuditEntry[] = [];
    let total = 0;
    let scanned = 0;
    let totalIsCapped = false;

    const collect = (line: Buffer): boolean => {
      if (line.length === 0) return false;
      scanned++;
      try {
        const entry = JSON.parse(line.toString('utf8')) as AuditEntry;
        if (options.since && entry.ts < options.since) return true;

        if (total >= offset && entries.length < options.pageSize) {
          entries.push(entry);
        }
        total++;
      } catch {
        // Skip malformed lines
      }
      if (scanned >= countLimit) totalIsCapped = true;
      return totalIsCapped;
    };

    const dir = dirname(this.config.filePath);
    const base = basename(this.config.filePath);
    const rotatedFiles = (await readdir(dir))
      .map((file) => ({ file, index: Number(file.slice(base.length + 1)) }))
      .filter(
        ({ file, index }) =>
          file.startsWith(`${base}.`) && Number.isSafeInteger(index) && index > 0,
      )
      .sort((left, right) => left.index - right.index)
      .map(({ file }) => join(dir, file));
    const files = [this.config.filePath, ...rotatedFiles];
    let shouldStop = false;

    for (const filePath of files) {
      let file;
      try {
        file = await open(filePath, 'r');
      } catch (error) {
        if (isMissingFileError(error)) continue;
        throw error;
      }

      try {
        const { size } = await file.stat();
        let position = size;
        let remainder = Buffer.alloc(0);

        while (position > 0 && !shouldStop) {
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
            shouldStop = collect(data.subarray(index + 1, lineEnd));
            lineEnd = index;
            if (shouldStop) break;
          }
          remainder = Buffer.from(data.subarray(0, lineEnd));
        }

        if (!shouldStop) shouldStop = collect(remainder);
      } finally {
        await file.close();
      }

      if (shouldStop) break;
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

        const oldestFile = join(dir, `${base}.${this.config.maxFiles}`);
        const oldestStats = await stat(oldestFile).catch((error: unknown) => {
          if (isMissingFileError(error)) return undefined;
          throw error;
        });
        const willDiscardOldest =
          this.config.maxFiles === 1 ||
          (await stat(join(dir, `${base}.${this.config.maxFiles - 1}`))
            .then(() => true)
            .catch((error: unknown) => {
              if (isMissingFileError(error)) return false;
              throw error;
            }));
        if (
          oldestStats &&
          willDiscardOldest &&
          !this.hasWarnedAboutRotationTruncation &&
          Date.now() - oldestStats.mtimeMs < this.config.retentionDays * 24 * 60 * 60 * 1000
        ) {
          this.hasWarnedAboutRotationTruncation = true;
          this.logger?.warn(
            {
              filePath: this.config.filePath,
              maxFiles: this.config.maxFiles,
              maxFileSizeMB: this.config.maxFileSizeMB,
              retentionDays: this.config.retentionDays,
            },
            'Audit log rotation is discarding a file before its retention period; increase maxFiles or maxFileSizeMB to retain more history',
          );
        }

        // Shift existing rotated files, replacing the oldest generation when at capacity.
        for (let i = this.config.maxFiles - 1; i >= 1; i--) {
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
      this.rotationError = undefined;
    } catch (error) {
      // Rotation failures must not prevent audit appends, but readiness must surface them.
      if (isMissingFileError(error)) {
        // There is nothing to rotate until the first append creates the file.
        this.rotationError = undefined;
      } else {
        this.rotationError = errorMessage(error);
        this.logger?.warn(
          { err: error, filePath: this.config.filePath },
          'Failed to rotate audit log',
        );
      }
    }

    // Retention is time-based, so it must not depend on a size-triggered rotation.
    const now = Date.now();
    if (now - this.lastPruneMs > 60 * 60 * 1000) {
      this.lastPruneMs = now;
      await this.pruneExpiredLogs();
    }
  }

  private async pruneExpiredLogs(): Promise<void> {
    const dir = dirname(this.config.filePath);
    const base = basename(this.config.filePath);
    const maxAgeMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    try {
      await this.pruneActiveFile(now, maxAgeMs);
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
      this.pruneError = undefined;
    } catch (error) {
      this.pruneError = errorMessage(error);
      this.logger?.warn(
        { err: error, filePath: this.config.filePath },
        'Failed to prune audit logs',
      );
    }
  }

  private async pruneActiveFile(now: number, maxAgeMs: number): Promise<void> {
    const fileStats = await stat(this.config.filePath).catch((error: unknown) => {
      if (isMissingFileError(error)) return undefined;
      throw error;
    });
    if (!fileStats || !fileStats.isFile()) return;

    let content: string;
    content = await readFile(this.config.filePath, 'utf8');
    const lines = content.split('\n');
    const retainedLines = lines.filter((line) => !this.isExpiredAuditEntry(line, now, maxAgeMs));
    if (retainedLines.length === lines.length) return;

    const temporaryPath = join(
      dirname(this.config.filePath),
      `.${basename(this.config.filePath)}.retention-${process.pid}-${Date.now()}`,
    );
    await writeFile(temporaryPath, retainedLines.join('\n'), { encoding: 'utf8', flag: 'w' });
    await rename(temporaryPath, this.config.filePath);
  }

  private isExpiredAuditEntry(line: string, now: number, maxAgeMs: number): boolean {
    if (!line) return false;
    try {
      const timestamp = Date.parse((JSON.parse(line) as AuditEntry).ts);
      return !Number.isNaN(timestamp) && now - timestamp > maxAgeMs;
    } catch {
      // Preserve malformed lines: they cannot be safely classified by age.
      return false;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
