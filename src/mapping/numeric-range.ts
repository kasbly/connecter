import { STATUS_VALUE_BTRIM_CHARS_SQL } from './field-mapper.js';

/**
 * PostgreSQL evaluates `AND` terms in an order of its choosing, so a regex
 * predicate beside an unconditional `::numeric` cast cannot protect dirty text
 * values. Keep the validation and cast in one CASE expression instead.
 */
// Deliberately avoids `?`: Knex treats question marks in raw expressions as
// parameter placeholders even when they are part of a PostgreSQL regex.
const NUMERIC_TEXT_PATTERN =
  '^[+-]{0,1}([0-9]+(\\.[0-9]*){0,1}|\\.[0-9]+)([eE][+-]{0,1}[0-9]+){0,1}$';

/**
 * Returns a numeric expression that is NULL for values PostgreSQL cannot
 * parse as numbers. This lets range filters skip imported placeholders such
 * as `N/A` instead of aborting the whole inventory query with SQLSTATE 22P02.
 */
export function safeNumericRangeExpression(column: string): string {
  // One-argument `btrim` only strips spaces; JavaScript's `Number()` (used when
  // publishing) also ignores tabs, CR/LF, NBSP and BOM, so trim the same set.
  const textValue = `btrim(${column}::text, ${STATUS_VALUE_BTRIM_CHARS_SQL})`;
  return `CASE WHEN ${textValue} ~ '${NUMERIC_TEXT_PATTERN}' THEN ${textValue}::numeric END`;
}
