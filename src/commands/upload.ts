import { UsageError } from '../options.js';
import type { HttpClient, HttpRequest } from '../http.js';
import { progress } from '../progress.js';
import { call, type OperationId } from '../spec.js';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
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
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
};

/**
 * What the CLI uploads a form image as. A test holds the list to the spec's
 * `image_type`, which is where it would otherwise drift.
 */
export const FORM_IMAGE_TYPES = [
  'description',
  'header',
  'wallpaper',
  'opensearch_header',
  'wheel_fortune_prize'
] as const;
export type FormImageType = (typeof FORM_IMAGE_TYPES)[number];

/**
 * A file on disk, as multipart. The three endpoints that take one authenticate
 * like every other request, so there is no ticket to fetch first: the file goes
 * up in one call and comes back with an id to refer to it by.
 */
export function upload(
  id: OperationId,
  path: Record<string, string>,
  file: string,
  extra: Record<string, string> = {}
): HttpRequest {
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
  return call(id, { path, form });
}

/**
 * The size of a file about to go up, once it is found to be a file this
 * process may read. A bare stat passes a directory and an unreadable file, and
 * a command uploading several would then fail only after the first went up.
 */
export function readableSize(file: string): number {
  try {
    accessSync(file, constants.R_OK);
    const stats = statSync(file);
    if (stats.isFile()) return stats.size;
  } catch (error) {
    throw new UsageError(`could not read ${file}: ${(error as Error).message}`);
  }
  throw new UsageError(`could not read ${file}: not a file`);
}

/** One file to upload, and the key of the id the answer gives it. */
interface Upload {
  id: OperationId;
  path?: Record<string, string>;
  file: string;
  extra?: Record<string, string>;
  key: string;
}

/** A file uploaded with a progress line while it goes, answered by its id. */
export async function uploadedId(client: HttpClient, { id, path = {}, file, extra, key }: Upload): Promise<string> {
  const watching = progress();
  watching.step(`uploading ${basename(file)}…`);
  try {
    const answer = await client.request<Record<string, string>>(upload(id, path, file, extra));
    return answer[key];
  } finally {
    watching.done();
  }
}

/**
 * An image that a form's theme, one of its public queries or a prize of its lucky wheel
 * refers to by id, uploaded with `imageType` saying which.
 */
export function uploadFormImage(client: HttpClient, file: string, imageType: FormImageType): Promise<string> {
  return uploadedId(client, { id: 'uploadFormImage', file, extra: { image_type: imageType }, key: 'attachment_id' });
}
