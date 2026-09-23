import type { HttpClient, HttpRequest } from '../http.js';
import type { OptionSpec } from '../options.js';
import type { TextHints } from '../render.js';

export interface ArgSpec {
  readonly name: string;
  readonly required: boolean;
  /** Takes the rest of the words; only the last argument may. */
  readonly variadic?: boolean;
  readonly description: string;
}

/** How a listing returns its next page, which is what `--all` follows. */
export interface Pagination {
  readonly items: string;
  readonly cursor: string;
}

export interface CommandInput {
  readonly args: Record<string, string>;
  /** The values of a variadic argument, in the order given. */
  readonly rest: readonly string[];
  readonly options: Record<string, unknown>;
}

export interface Command {
  /** The words that select it: `['entry', 'list']`. */
  readonly path: readonly string[];
  /** One line, shown under its resource in the root help. */
  readonly summary: string;
  readonly description?: string;
  readonly args?: readonly ArgSpec[];
  readonly options?: readonly OptionSpec[];
  /**
   * What `--json` expects, shown in help. A flag named `<json>` says nothing
   * about what goes in the file, and a caller with nothing to copy from cannot
   * guess it — so the commands that take a payload show one.
   */
  readonly payload?: readonly string[];
  readonly examples?: readonly string[];
  /** The one request the command is. Most commands are this and nothing else. */
  readonly request?: (input: CommandInput) => HttpRequest;
  /**
   * For the commands a single request cannot express, or that have to decide
   * how many they are: uploading a file and then acting on it. It gets the
   * client and returns whatever should be printed. A command has one of
   * `request` and `run`, never both.
   */
  readonly run?: (input: CommandInput, client: HttpClient) => Promise<unknown>;
  readonly paginate?: Pagination;
  /**
   * Narrows the response to what the command is about. `field list` asks for a
   * form because that is where fields live, but a caller asked for the fields.
   */
  readonly select?: (body: unknown) => unknown;
  /**
   * Reshapes the response for reading, and only for reading: `--output json`
   * answers what the API answered. A command needs this when its payload is
   * built for indexing rather than for looking at, and no generic renderer
   * could know how to put it back together.
   */
  readonly render?: (body: unknown) => unknown;
  /**
   * What the text renderer cannot read off the payload: the key holding the
   * listing when it is not `data` or the paginated one, and the lists inside
   * a row that are the answer rather than detail.
   */
  readonly text?: TextHints;
}

export interface Resource {
  readonly name: string;
  readonly summary: string;
}
