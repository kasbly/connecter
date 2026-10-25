import type { Knex } from 'knex';

/** Unix seconds sit below 1e12; JavaScript/Java millisecond epochs do not. */
function inferUpdatedAtEpoch(sample: number): 's' | 'ms' {
  return Math.abs(sample) < 1e12 ? 's' : 'ms';
}

function parseEpochSample(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

/**
 * Units prompt for a numeric last-updated column. A sampled value picks the
 * default (`abs < 1e12` → seconds). With no sample, keep a previous answer, else
 * seconds.
 */
export function getUpdatedAtEpochPrompt(
  sample: number | undefined,
  existingEpoch?: 's' | 'ms',
): {
  message: string;
  choices: Array<{ name: string; value: 's' | 'ms' }>;
  default: 's' | 'ms';
} {
  const sampled = sample !== undefined && Number.isFinite(sample) ? sample : undefined;
  return {
    message:
      sampled === undefined
        ? 'Which Unix timestamp units does the last-updated column use?'
        : `Which Unix timestamp units does the last-updated column use? Sampled value: ${sampled}.`,
    choices: [
      { name: 'Seconds (for example, 1710000000)', value: 's' },
      { name: 'Milliseconds (for example, 1710000000000)', value: 'ms' },
    ],
    default: sampled === undefined ? (existingEpoch ?? 's') : inferUpdatedAtEpoch(sampled),
  };
}

/** One non-null value from a numeric last-updated column, or undefined when it cannot be read. */
export async function sampleUpdatedAtValue(
  db: Knex,
  schema: string,
  table: string,
  column: string,
): Promise<number | undefined> {
  try {
    const result = await db.raw<{ rows: Array<{ value: unknown }> }>(
      `SELECT ?? AS "value" FROM ??.?? WHERE ?? IS NOT NULL LIMIT 1`,
      [column, schema, table, column],
    );
    return parseEpochSample(result.rows[0]?.value);
  } catch (error) {
    console.warn(
      `Could not sample "${column}" to choose timestamp units (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
    return undefined;
  }
}
