# Architecture

How `@jinshuju/cli` is put together, and the decisions behind it. The README
says what the CLI does; this says how, for whoever changes it next.

## Goals

- **Scriptable first.** The CLI is run by shell scripts and by agents at least
  as often as by a person at a prompt. Every answer is available as JSON, every
  failure has an exit code that says what kind it was, and nothing is ever
  written to stdout that is not the answer.
- **One request per command, made visible.** A command is data describing the
  request it makes. Help, argument checking and dispatch all read that data, so
  a command cannot be reachable without help and cannot accept a flag it never
  described.
- **No runtime dependencies.** Node 20's `fetch`, `FormData`, `node:test` and
  `node:http` are enough. The install is the package and nothing else.
- **The server owns its vocabulary.** Field types, scenes, operators and
  aggregation functions are the API's to define and to refuse. The CLI checks
  shapes and passes words through.

## Module map

```
src/
  cli-bin.ts        #!/usr/bin/env node — runs runCli, writes the result, sets the exit code
  cli.ts            runCli: find the command, split the line, dispatch; the --all paging loop
  args.ts           the command line taken apart: words, flags, values coerced by option type
  commands/
    index.ts        COMMANDS, RESOURCES, findCommand
    types.ts        Command, CommandInput, ArgSpec, Pagination — the shape of the table
    shared.ts       what more than one resource builds requests from: paths, filters, paging
    upload.ts       a file on disk as a multipart request
    account.ts folder.ts form.ts table.ts field.ts view.ts entry.ts comment.ts opensearch.ts
                    one table of commands per resource
    local.ts        the auth and config commands, in the table so they have help
  local.ts          runs the auth and config commands (they never reach the API)
  options.ts        the shared option grammar, and the parsers for --filter, --sort, --metric
  payload.ts        the shape check on a form or table payload
  http.ts           JinshujuHttpClient: auth header, deadline, retry, query serialization
  auth.ts           OAuth with PKCE on a loopback port; refresh; revoke
  config.ts         ~/.jinshuju/config.json and the env, with precedence and provenance
  errors.ts         the error classes and classify(): kind and exit code
  result.ts         CliResult, CliRuntime, and how a failure is written out
  render.ts         text, json and jsonl; the table layout and CJK-aware widths
  progress.ts       one overwritten line on stderr, only when stderr is a terminal
  values.ts         isRecord, isScalar
  version.ts        VERSION, read from package.json
```

Dependencies point downward: `cli.ts` knows everything, `commands/` knows
`options`, `http` and `render` types, `http.ts` knows `config`, `auth` and
`errors`, and `errors.ts`, `values.ts`, `version.ts` know nothing.

## A request, end to end

1. `cli-bin.ts` calls `runCli(argv, { stdout })` and writes back whatever it
   answers. `runCli` never throws and never writes; it returns
   `{ exitCode, stdout, stderr }`. That is what makes the whole CLI testable by
   calling one function.
2. `runCli` finds the command from the leading words (`args.leadingWords`,
   `commands.findCommand`), then splits the line knowing which flags take a
   value (`args.splitArgs`). The order matters: only the command says whether
   `--yes 12` is a flag and an argument or a flag with a value.
3. Flags are bound to the command's option specs (`args.bindOptions`): an
   unknown flag is refused by name, a value is coerced by its declared type,
   and `--json` reads inline JSON, `@file` or `-` for stdin right there.
4. `auth` and `config` go to `local.ts`. Everything else goes to `runRemote`,
   which builds the `HttpClient` from config and either calls the command's
   `run` or sends its `request`.
5. `JinshujuHttpClient.request` adds the credential, a `User-Agent` and a
   deadline, serializes the query, and sends. A 401 on a stored OAuth session
   refreshes the token and tries once more. A retryable status is tried again
   after backing off. A failure becomes an `HttpError` carrying the status and
   body, or a `TransportError` if there was no response at all.
6. The payload is narrowed by `select`, reshaped for reading by `render`, and
   formatted as text, `json` or `jsonl` (`render.format`). With `--all` the
   pages are read in a loop; under `jsonl` each page is written as it arrives
   through the runtime's `stdout` writer and nothing is held.
7. Any error reaching `runCli` is sorted by `errors.classify` into a kind and
   exit code, and written to stderr as a line of text or, under `json` and
   `jsonl`, as `{ "error": { kind, message, status, body } }`.

## The command table

A `Command` is data, not a class:

| field                                           | meaning                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `path`                                          | the words that select it: `['entry', 'list']`                                                              |
| `summary`, `description`, `examples`, `payload` | what help shows; nothing else is                                                                           |
| `args`, `options`                               | what it accepts; anything not listed is refused                                                            |
| `request(input)`                                | the one request the command is, for the commands that are one                                              |
| `run(input, client)`                            | for the commands that are more than one request, or must decide how many; returns what to print            |
| `paginate`                                      | which keys hold the rows and the cursor, so `--all` can follow it                                          |
| `select`, `render`                              | narrow the payload; reshape it for text only                                                               |
| `text`                                          | hints the text renderer cannot read off the payload: the listing key, the lists worth breaking a table for |

A command has one of `request` and `run`, never both. `run` exists for form
create with an exam settings block (two requests, and the second may be
refused after the first landed), for uploads that produce an id the real
request needs, and for `entry import --wait`. Each of those says in its error
exactly what did and did not happen, because "nothing happened" would invite
the caller to do it again.

Two command files decide **what** is sent; nothing in them decides **how**.
Query strings, credentials, timeouts, retries and error shapes are the
client's business, which is why `HttpRequest.query` is values and not a string.

## Errors and exit codes

Every failure is one of seven kinds, and the exit code is the kind:

| code | kind       | raised as                                                                           |
| ---- | ---------- | ----------------------------------------------------------------------------------- |
| 1    | unexpected | any `Error` nothing below claims                                                    |
| 2    | usage      | `UsageError`: flags, arguments, input files, unknown commands, a broken config file |
| 3    | auth       | `AuthError`, or an `HttpError` with 401 or 403                                      |
| 4    | not_found  | `HttpError` 404                                                                     |
| 5    | refused    | `HttpError` other 4xx, or `RefusedError` (an import the server would not write)     |
| 6    | server     | `HttpError` 5xx, or a 2xx whose body could not be read                              |
| 7    | transport  | `TransportError`: no connection, or the deadline passed                             |

An error that wraps another (`{ cause }`) is sorted by what it wraps and keeps
its own words, so "the form was created but its settings were refused" exits 5
and still says the form exists.

## Credentials

`config.loadConfig` reads the command line, the environment and the file, in
that order of precedence, and records where each value came from so
`auth status` can say so. The client then picks a credential in this order:
an access token, an API key and secret, a stored OAuth session. An explicit
credential always beats a stored login; using last week's session when a
token was set would be a surprise with no signal.

OAuth is authorization code with PKCE. The CLI listens on a loopback port,
checks the returned `state` with a constant-time compare, exchanges the code,
and stores the session in the config file, mode 600, written atomically.

## Output

`text` is for a person: a table when the rows are alike, `key: value` when
they are not, columns ordered by what identifies a row, long cells clipped,
widths counted in terminal cells so a Chinese column lines up. `json` is the
payload as the API answered it, pretty-printed. `jsonl` is one object per
line, a listing as its rows, and the one format that can stream.

Progress goes to stderr, one overwritten line, and only when stderr is a
terminal. A pipe, and an agent on the other end of it, never sees a stray
character.

## Tests

`npm test` builds and runs `node --test` over `dist/`. Most tests call
`runCli` with a mock `HttpClient` and assert on the request that would have
been sent and the result that came back: no network, no config file, no
process state. The HTTP client and OAuth are tested against `node:http`
servers on a loopback port. A temporary config path is passed everywhere so
the suite never reads the developer's own credentials.

## Tooling and release

- `npm run check` is typecheck, `oxlint` and `oxfmt --check`; CI runs the same
  on Node 20 and 22, then packs the tarball, installs it and starts both
  binaries.
- Commits are conventional commits, and PRs are squash-merged so each lands as
  one. release-please keeps a release PR open from `feat` and `fix` commits;
  merging it tags, releases and publishes to npm through OIDC trusted
  publishing. No token is stored anywhere.
- `VERSION` is read from `package.json` at runtime, so a release bumps one
  file.
