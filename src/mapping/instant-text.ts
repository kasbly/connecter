/**
 * A `text`/`varchar` last-updated column orders and compares as characters, so
 * `13:00:00+03:00` (10:00 UTC) sorts after `11:45:00Z` and clears an
 * `updatedSince=11:15Z` cutoff it does not meet (#39099). The mapper publishes
 * these values as ISO instants, so ordering and cutoff selection must compare
 * the instants they represent.
 */

// Deliberately avoids `?` and backslashes: Knex treats question marks in raw
// expressions as parameter placeholders even inside a PostgreSQL regex.
const LEAP_YEAR = '([0-9]{2}(0[48]|[2468][048]|[13579][26])|(0[48]|[2468][048]|[13579][26])00)';
// Every calendar-valid date, so a matched value can never abort the query with
// SQLSTATE 22008 when it is cast. 0000 is not a PostgreSQL year.
const YEAR = '(0[0-9]{2}[1-9]|0[0-9][1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3})';
const ISO_DATE =
  `(${YEAR}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])` +
  '|(0[469]|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8]))' +
  `|${LEAP_YEAR}-02-29)`;
const ISO_TIME = '[T ]([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]+){0,1}){0,1}';
const ISO_OFFSET = '(Z|[+-](0[0-9]|1[0-4])(:{0,1}[0-5][0-9]){0,1})';

const ISO_WITH_OFFSET_PATTERN = `^${ISO_DATE}${ISO_TIME}${ISO_OFFSET}$`;
const ISO_WITHOUT_OFFSET_PATTERN = `^${ISO_DATE}(${ISO_TIME}){0,1}$`;

/** Column types stored as characters; native date/time types keep their own order. */
const TEXT_TYPES_SQL = "('text'::regtype, 'character varying'::regtype, 'bpchar'::regtype)";

/** SQL predicate: the column is a character type whose values are text, not instants. */
export function isTextColumnExpression(column: string): string {
  return `pg_typeof(${column}) IN ${TEXT_TYPES_SQL}`;
}

/**
 * Returns a `timestamptz` expression that is NULL unless the column is a text
 * type holding a supported ISO-8601 date or timestamp. Values with an offset or
 * `Z` keep it; a date or timestamp without one is read as UTC, like the DATE
 * promotion in `updatedSince` (#38180). The value is validated and cast in one
 * CASE so a non-ISO placeholder never aborts the query.
 */
export function isoTextInstantExpression(column: string): string {
  const textValue = `btrim(${column}::text)`;
  return (
    `CASE WHEN ${isTextColumnExpression(column)} THEN ` +
    `CASE WHEN ${textValue} ~ '${ISO_WITH_OFFSET_PATTERN}' THEN ${textValue}::timestamptz ` +
    `WHEN ${textValue} ~ '${ISO_WITHOUT_OFFSET_PATTERN}' THEN (${textValue}::timestamp AT TIME ZONE 'UTC') END END`
  );
}
