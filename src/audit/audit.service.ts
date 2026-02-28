import { appendFileSync, existsSync, mkdirSync, statSync, renameSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import type { AuditConfig } from '../config/config.types.js';

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

  constructor(config: AuditConfig) {
    this.config = config;
    if (config.enabled) {
      const dir = dirname(config.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  log(entry: AuditEntry): void {
    if (!this.config.enabled) return;

    this.rotateIfNeeded();
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.config.filePath, line, 'utf-8');
  }

  query(options: AuditQueryOptions): { entries: AuditEntry[]; total: number } {
    if (!this.config.enabled || !existsSync(this.config.filePath)) {
      return { entries: [], total: 0 };
    }

    const content = readFileSync(this.config.filePath, 'utf-8');
    const lines = content.trim().split('\n').filter((l) => l.length > 0);

    let entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (options.since && entry.ts < options.since) continue;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    // Reverse to show newest first
    entries.reverse();
    const total = entries.length;
    const offset = (options.page - 1) * options.pageSize;
    entries = entries.slice(offset, offset + options.pageSize);

    return { entries, total };
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.config.filePath)) return;

    try {
      const stats = statSync(this.config.filePath);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB >= this.config.maxFileSizeMB) {
        const dir = dirname(this.config.filePath);
        const base = basename(this.config.filePath);

        // Shift existing rotated files
        for (let i = 9; i >= 1; i--) {
          const from = join(dir, `${base}.${i}`);
          const to = join(dir, `${base}.${i + 1}`);
          if (existsSync(from)) {
            renameSync(from, to);
          }
        }

        renameSync(this.config.filePath, join(dir, `${base}.1`));
        this.pruneOldFiles();
      }
    } catch {
      // Silently ignore rotation errors
    }
  }

  private pruneOldFiles(): void {
    const dir = dirname(this.config.filePath);
    const base = basename(this.config.filePath);
    const maxAgeMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(base + '.') && file !== base) {
          const filePath = join(dir, file);
          const stats = statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            unlinkSync(filePath);
          }
        }
      }
    } catch {
      // Silently ignore prune errors
    }
  }
}
