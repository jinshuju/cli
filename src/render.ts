import type { OutputFormat } from './options.js';
import { isRecord, isScalar } from './values.js';

/**
 * How a response is put on the page. `--output json` is the payload as the
 * API answered it; text is the same payload laid out for a person: a table
 * where the rows are alike, `key: value` where they are not, and nothing a
 * reader has to parse braces to find.
 */

const MAX_CELL = 120;

/** What a table is allowed to be wide when nobody is watching it on a screen. */
const PIPED_WIDTH = 120;

/** Columns that say which row this is; they earn their place before any value. */
const LEADING_COLUMNS = [
  'token',
  'api_code',
  'serial_number',
  'id',
  'name',
  'title',
  'label',
  'type',
  'state',
  'status'
];

/**
 * Timestamps go last, however early they appear in the payload. On a listing of
 * rows they are the least of what the reader came for, and taking them in
 * payload order is what left `entry list` showing two of a form's ten fields.
 */
const TRAILING_COLUMNS = ['created_at', 'updated_at'];

/**
 * A column that names the row rather than saying anything about it. The listed
 * ones plus whatever ends in `_token` or `_id`, because a search answers with
 * `form_token` and a row showing only that has told the reader nothing.
 */
function identifies(column: string): boolean {
  return LEADING_COLUMNS.includes(column) || /(^|_)(token|id)$/.test(column);
}

export function terminalWidth(stream: NodeJS.WriteStream = process.stdout): number {
  return stream.isTTY && stream.columns > 0 ? stream.columns : PIPED_WIDTH;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * One JSON object per line, which is what `jq -c`, a shell loop and a log
 * shipper all read without holding the whole answer first. A listing becomes
 * its rows, one each; anything else is one line.
 */
export function jsonl(value: unknown, listKey?: string): string {
  const rows = listOf(value, listKey);
  return (rows ?? [value]).map((row) => JSON.stringify(row)).join('\n');
}

/** The rows a payload carries, when it is a listing. */
function listOf(value: unknown, listKey?: string): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  const key = listKey ?? 'data';
  return Array.isArray(value[key]) ? (value[key] as unknown[]) : undefined;
}

/**
 * What a command knows about the shape of its answer that no renderer could
 * read off the payload: which key holds the listing when it is not `data`, and
 * which lists inside a row are the answer rather than detail.
 */
export type TextHints = {
  readonly list?: string;
  readonly essentialLists?: readonly string[];
};

type Layout = { width: number; list: string; essentialLists: readonly string[] };

/** The payload in the format asked for. */
export function format(value: unknown, output: OutputFormat, width: number, hints: TextHints = {}): string {
  if (output === 'json') return json(value);
  if (output === 'jsonl') return jsonl(value, hints.list);
  return text(value, width, hints);
}

export function text(value: unknown, width: number, hints: TextHints = {}): string {
  return render(value, { width, list: hints.list ?? 'data', essentialLists: hints.essentialLists ?? [] });
}

function render(value: unknown, layout: Layout): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return renderList(value, layout);
  if (typeof value === 'object') return renderObject(value as Record<string, unknown>, layout);
  return String(value);
}

function renderObject(value: Record<string, unknown>, layout: Layout): string {
  const listKey = Array.isArray(value[layout.list]) ? layout.list : undefined;

  if (listKey) {
    // Everything beside the listing is rendered, not just its scalars. Filtering
    // to scalars here was another way for a payload to lose a key on the way to
    // the page — the warnings an import answers with, say.
    const heading = Object.entries(value)
      .filter(([key]) => key !== listKey)
      .map(([key, fieldValue]) => renderEntry(key, fieldValue, layout));
    const listText = renderList(value[listKey] as unknown[], layout);

    // A response that is nothing but the listing has nothing to separate it
    // from, and `data:` on its own line is the JSON envelope showing through.
    if (heading.length === 0) return listText;

    return [...heading, `${listKey}:`, listText].filter(Boolean).join('\n');
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return entries.map(([key, fieldValue]) => renderEntry(key, fieldValue, layout)).join('\n');
}

/**
 * A setting is an object of objects, and printing it as JSON asks the reader to
 * parse braces to find one flag. Nesting goes one indent deeper instead, so the
 * shape stays visible and every leaf reads as `key: value`.
 */
function renderEntry(key: string, value: unknown, layout: Layout): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? `${key}: (empty)` : `${key}:\n${indent(renderList(value, layout))}`;
  }
  if (value !== null && typeof value === 'object') {
    const block = renderObject(value as Record<string, unknown>, layout);
    return block === '{}' ? `${key}: {}` : `${key}:\n${indent(block)}`;
  }
  return `${key}: ${formatCell(value)}`;
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
}

function renderList(values: unknown[], layout: Layout): string {
  if (values.length === 0) return '(empty)';
  if (!values.every(isRecord)) return values.map((item) => formatField(item)).join('\n');

  const { rows, headings } = splitLabels((values as Record<string, unknown>[]).map(unwrapKeyed));
  if (rows.some((row) => hasEssentialList(row, layout.essentialLists))) {
    return rows.map((row) => renderObject(row, layout)).join('\n\n');
  }

  const heading = (column: string): string => headings.get(column) ?? column;
  const candidates = candidateColumns(rows);
  if (candidates.length === 0) return rows.map((row) => json(row)).join('\n');

  const columns: string[] = [];
  const widths: number[] = [];
  let used = 0;
  for (const column of candidates) {
    const columnWidth = Math.max(
      displayWidth(heading(column)),
      ...rows.map((row) => displayWidth(formatCell(row[column])))
    );
    const next = used + (columns.length === 0 ? 0 : 2) + columnWidth;
    // The first column goes in whatever it costs: a table of nothing is worse
    // than a table too wide.
    if (columns.length > 0 && next > layout.width) break;
    columns.push(column);
    widths.push(columnWidth);
    used = next;
  }

  // A row that says nothing but its own name says nothing at all — and the
  // column that would have explained it is exactly the one a narrow terminal
  // drops. `entry search` keeps a form it could not read *with the reason*, and
  // the budget must not be what throws that reason away. A row left with only
  // its identity buys back one column, whatever the width says.
  const told = (row: Record<string, unknown>, column: string): boolean =>
    !identifies(column) && formatCell(row[column]) !== '';
  for (const row of rows) {
    if (columns.some((column) => told(row, column))) continue;
    const rescued = candidates.find((column) => !columns.includes(column) && told(row, column));
    if (!rescued) continue;
    columns.push(rescued);
    widths.push(
      Math.max(displayWidth(heading(rescued)), ...rows.map((other) => displayWidth(formatCell(other[rescued]))))
    );
  }

  const header = columns.map((column, index) => pad(heading(column), widths[index])).join('  ');
  const separator = widths.map((columnWidth) => '-'.repeat(columnWidth)).join('  ');
  const body = rows.map((row) =>
    columns.map((column, index) => pad(formatCell(row[column]), widths[index])).join('  ')
  );
  return [header, separator, ...body].join('\n');
}

/**
 * Every column the rows could show, best first. How many of them fit is the
 * caller's question, and it needs their widths to answer it.
 */
function candidateColumns(rows: Record<string, unknown>[]): string[] {
  const present = (key: string): boolean =>
    rows.some((row) => Object.prototype.hasOwnProperty.call(row, key) && isCell(row[key]));

  const seen = new Set<string>(LEADING_COLUMNS.filter(present));
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (isCell(value) && !TRAILING_COLUMNS.includes(key)) seen.add(key);
    }
  }
  for (const key of TRAILING_COLUMNS.filter(present)) seen.add(key);
  return [...seen];
}

/**
 * A form's fields arrive as `{ "field_1": { label, type, ... } }`, one key per
 * row. A table of those reads as a column per field and nothing in it, so the
 * key becomes a cell of its own row instead.
 */
function unwrapKeyed(row: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(row);
  if (entries.length !== 1) return row;
  const [key, value] = entries[0];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return row;
  return { api_code: key, ...(value as Record<string, unknown>) };
}

/**
 * `--labels` answers each field as `{ label, value }`. A cell cannot hold a
 * pair, and a column of pairs is no column at all — which is why the values
 * used to vanish from the table entirely. The pair is split instead: the value
 * becomes the cell, the label becomes the column's heading. Columns stay keyed
 * by api_code, because two fields may carry the same label.
 */
function splitLabels(rows: Record<string, unknown>[]): {
  rows: Record<string, unknown>[];
  headings: Map<string, string>;
} {
  const headings = new Map<string, string>();
  const split = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!isLabelled(value)) {
        out[key] = value;
        continue;
      }
      const { label, value: cell } = value as { label: unknown; value: unknown };
      if (typeof label === 'string' && label !== '') headings.set(key, label);
      out[key] = cell;
    }
    return out;
  });
  return { rows: split, headings };
}

function isLabelled(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 2 && keys.includes('label') && keys.includes('value');
}

/**
 * A row carrying a list of its own has no cell a table could put it in, and the
 * table drops it. Usually that is the right trade — a field's `choices` are
 * detail, and the row still says what the field is. An analysis' buckets are
 * not detail: they are the answer, and a table of `entry summary` without them
 * prints how many people answered and never what they answered.
 *
 * Which is which is not readable off the shape — both are a list of objects
 * beside a handful of scalars — so the command names the lists worth breaking
 * the table for, in its `text` hints.
 */
function hasEssentialList(row: Record<string, unknown>, essential: readonly string[]): boolean {
  return essential.some((key) => {
    const value = row[key];
    return Array.isArray(value) && value.length > 0 && value.every(isRecord);
  });
}

/**
 * Whether a value earns its key a column. A list of values does: a
 * multiple-choice answer is a list, and so is the `serial_numbers` a search
 * answers with. Treating those as unprintable dropped the column — which meant
 * `--fields field_6` left out field_6, and `entry search` said how many rows
 * matched without ever saying which.
 *
 * An empty list earns nothing, though. A column that is `[]` in every row is a
 * heading with a blank under it for as far as the table goes.
 */
function isCell(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isScalar);
  return isScalar(value);
}

function formatField(value: unknown): string {
  if (isScalar(value)) return formatCell(value);
  return json(value);
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every(isScalar)) return clip(value.map(formatCell).join(', '));
  return clip(JSON.stringify(value));
}

/**
 * One rich text field is longer than the rest of a form put together, and it
 * wraps over a screen of terminal. Text is the readable format; whoever wants
 * the whole value asks for --output json.
 */
function clip(value: string): string {
  return value.length <= MAX_CELL ? value : `${value.slice(0, MAX_CELL)}… (${value.length} chars)`;
}

/**
 * A column is padded to what the terminal shows, not to how many code points
 * the value holds: a Chinese label takes two cells per character, so counting
 * length leaves every table with a Chinese column ragged.
 */
function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += isWide(char.codePointAt(0) as number) ? 2 : 1;
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}
