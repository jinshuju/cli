import { UsageError } from '../options.js';
import type { HttpRequest } from '../http.js';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

/**
 * The media type of an upload, by extension. The server stores the type the
 * multipart part declares and decides from it what the file may be used for, so
 * an untyped part is an .xlsx it refuses as not a spreadsheet.
 */
const UPLOAD_TYPES: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
};

/**
 * A file on disk, as multipart. The three endpoints that take one authenticate
 * like every other request, so there is no ticket to fetch first: the file goes
 * up in one call and comes back with an id to refer to it by.
 */
export function upload(path: string, file: string, extra: Record<string, string> = {}): HttpRequest {
  const form = new FormData();
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new UsageError(`could not read ${file}: ${(error as Error).message}`);
  }
  const type = UPLOAD_TYPES[extname(file).toLowerCase()];
  form.append('file', new Blob([new Uint8Array(bytes)], type ? { type } : undefined), basename(file));
  for (const [name, value] of Object.entries(extra)) form.append(name, value);
  return { method: 'POST', path, form };
}
