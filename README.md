# @jinshuju/cli

Command-line interface for the Jinshuju Open API v1.

## Install

```bash
npm install -g @jinshuju/cli
```

Two equivalent entry points are installed:

```bash
jinshuju --help
jsj --help
```

## Working on the CLI itself

```bash
npm install
npm link          # jinshuju / jsj now resolve to your checkout
```

If `npm link` leaves you with `permission denied`, `dist/cli-bin.js` has lost
its execute bit — `npm run build` restores it.

## Authentication

Three kinds of credential are supported: an access token (personal or account),
an API key and secret pair, and an interactive browser login.

Write them to the config file (`~/.jinshuju/config.json`, mode 600):

```bash
jinshuju config set access_token xxx     # access token
jinshuju config set api_key xxx          # or API key / secret
jinshuju config set api_secret xxx
```

Environment variables work just as well, which suits CI and scripts:

```bash
export JINSHUJU_ACCESS_TOKEN=xxx
# or
export JINSHUJU_API_KEY=xxx
export JINSHUJU_API_SECRET=xxx
```

The **precedence** is access token, then API key and secret, then a stored
browser login (`jinshuju auth login`). An explicitly configured credential
always beats a stored session: setting a token and then acting as last week's
login is a surprise nobody wants. `jinshuju auth status` reports which
credential is in use and where it came from:

```
$ jinshuju auth status
Authenticated with an access token (from env).
```

Access tokens are masked in `config get` like any other secret; pass
`--show-secret` for the full value.

## Creating forms

Field types use the API v1 type names. Do not supply `api_code` when creating a
field — the server assigns it.

```bash
jinshuju form create --json @form.json --scene registry --layout card --folder Fd2xK8
jinshuju form create --json @exam.json --type exam        # the payload may carry exam_setting
jinshuju form edit Kp7mQ2 --json '{"exam_setting":{"limited_time":45}}'

jinshuju form create --json '{
  "name": "Event signup",
  "fields": [
    { "type": "TextField", "label": "Name", "required": true },
    { "type": "MobileField", "label": "Mobile", "required": true }
  ]
}'
```

`--type exam` and `--type evaluation` select both the scene and the settings
block that belongs to it. That settings block has an endpoint of its own, so a
payload carrying it becomes two requests — and the general form update does not
recognise the key at all (it reads only `name`, `description`, `setting`,
`fields` and `field_rules`), so without the dispatch `exam_setting` would be
dropped in silence.

The settings block is always sent first. It is the half that can be rejected —
"this is not an exam form" — and sending it first is what guarantees a rejection
leaves every other change unsent.

## Reading data

`entry`, `view`, `field` and `comment` are all top-level resources; the
container is given by `--form` or `--table` (mutually exclusive, both mapping to
the API's `form_token`).

```bash
jinshuju entry list --form Kp7mQ2
jinshuju entry list --table Vn4xR8
jinshuju entry get 1 --form Kp7mQ2
jinshuju entry list --form Kp7mQ2 --view aB3dE9
```

Filtering, sorting and paging:

```bash
jinshuju entry list --form Kp7mQ2 --filter 'field_3 gte 80'
jinshuju entry list --form Kp7mQ2 --filter 'created_at within_last 30d' --filter 'field_9 not_null'
jinshuju entry list --form Kp7mQ2 --sort created_at:desc
jinshuju entry list --form Kp7mQ2 --limit 10
jinshuju entry list --form Kp7mQ2 --all
```

`--limit` can only ask for less: a listing's default page size is also its
maximum (50 in most cases), and anything larger is capped.

`--filter` is repeatable and the conditions are AND-combined. For conditions it
cannot express, use `--filters <json|@file>`. Cursors are opaque strings — pass
the `next` value from the previous response back verbatim.

## Analysis

There is no need to pull rows out and count them yourself. Counts, aggregates
and profiles are computed server-side, and the size of the response depends only
on how many metrics you asked for and how many groups came back.

```bash
jinshuju entry count --form Kp7mQ2 --filter 'field_3 gte 80'
jinshuju entry count --form Kp7mQ2 --form Vn4xR8            # repeatable, up to 10 containers

jinshuju entry aggregate --form Kp7mQ2 --metric avg:field_3
jinshuju entry aggregate --form Kp7mQ2 --metric count:field_1 --by created_at:month --limit 12

jinshuju entry summary --form Kp7mQ2
jinshuju entry summary --form Kp7mQ2 --fields field_3,field_7 --no-overview
```

`--metric <func>:<field>` is repeatable, 1–20 of them; `--by <field>[:day|week|month]`
takes at most 2, and a date dimension must name a bucket. Which functions a
field accepts is the field's own answer — read `analytics.agg_funcs` from
`form get`.

A multi-container count takes no `--keyword`, and its `--filter` is limited to
`created_at`, `updated_at` and `creator_id`: the same api_code names a different
field in every container, so comparing across them would mean nothing.

## Creating entries

Payload keys are field `api_code`s, not field labels. `--json` accepts inline
JSON, `@file`, and `-` for stdin.

```bash
jinshuju entry create --form Kp7mQ2 --json '{
  "field_1": "Alice",
  "field_2": "13800138000"
}'

jinshuju entry create --form Kp7mQ2 --json @entry.json
cat entry.json | jinshuju entry create --form Kp7mQ2 --json -
```

## Writing

Apart from the settings-block dispatch described above, every write command
issues exactly one request, and payload keys are field `api_code`s.

```bash
jinshuju folder create Ledgers --kind table       # folders are form or table; a table cannot go in a form folder
jinshuju form edit Kp7mQ2 --json '{"name":"2026 signups"}'
jinshuju form copy Kp7mQ2 --name Copy
jinshuju form move Kp7mQ2 --folder Fd2xK8         # without --folder, moves it out of its folder
jinshuju form theme set Kp7mQ2 --primary-color "#1F6FEB"
jinshuju table create --json @table.json --folder Nf7mDC
jinshuju table edit Vn4xR8 --json '{"name":"2026 ledger"}'
```

Adding, changing and removing fields all land on a single PATCH of the
container:

```bash
jinshuju field add --form Kp7mQ2 --json '{"type":"TextField","label":"Notes"}'
jinshuju field update --form Kp7mQ2 field_3 --json '{"required":true}'
jinshuju field update-choices --form Kp7mQ2 field_7 --json '{"add":[{"label":"Third"}]}'
jinshuju field remove --form Kp7mQ2 field_9 --yes
```

Data and views:

```bash
jinshuju entry create --form Kp7mQ2 --batch @entries.json
jinshuju entry update --form Kp7mQ2 12 --json '{"field_2":99}'                 # merge
jinshuju entry update --form Kp7mQ2 12 --replace --json '{"field_1":"Bob"}'    # replace; omitted fields are cleared
jinshuju entry update --form Kp7mQ2 --batch @rows.json                         # [{serial_number, entry}]
jinshuju entry delete --form Kp7mQ2 12 --yes

jinshuju view create --form Kp7mQ2 "High scores" --filter 'field_3 gte 80' --sort created_at:desc
jinshuju comment create --form Kp7mQ2 --entry 12 "Contacted, awaiting reply"
jinshuju opensearch edit Qy7nR3 --disable
```

Deletion always requires `--yes`. This CLI is non-interactive — stdin belongs to
`--json -` — so confirmation is a flag: without it nothing is deleted, rather
than a prompt nobody is there to answer.

## Searching across containers

```bash
jinshuju entry search "Acme Corp"                     # every form and table you can read, up to 10
jinshuju entry search 13800138000 --form Kp7mQ2 --form Vn4xR8
jinshuju entry search repair --scope-filter 'entries_count gt 100'   # picks which forms to search, not which rows

jinshuju entry stats --from 2026-09-01                # how much each form received in the period
jinshuju entry stats --from 2026-09-01 --to 2026-09-07 --kind form --limit 10
```

A form that could not be searched stays in the result **with the reason**,
rather than being dropped as if it had matched nothing — "not searched" and
"nothing there" are different answers.

`entry stats` and `entry count` measure different things: the former is how much
arrived (an import counts on the day it ran, and deletions are not subtracted),
the latter is how much is there now.

## Your own submissions

```bash
jinshuju form list --mine                      # forms you filled in, not forms you own
jinshuju entry list --form Kp7mQ2 --mine       # what you submitted to this form
jinshuju entry search "Acme Corp" --mine        # search your own submissions
```

The scope is pinned to your own submissions: you cannot read anyone else's, and
you need no permission on the form itself. Flags that only make sense from an
owner's point of view (`--sort`, `--view`, `--scope-filter` and the like) are
rejected when combined with `--mine`.

## Working with files

Three commands take a file. The CLI uploads with its own credential; there is no
ticket to fetch first.

```bash
jinshuju entry import --form Kp7mQ2 ./signups.xlsx --map field_1=Name --map field_2=Mobile
jinshuju entry import --table Vn4xR8 ./rows.csv --map field_1=1 --map field_2=2 --header-row 2 --unique field_1

jinshuju entry create --form Kp7mQ2 --json '{"field_1":"Alice"}' --attach field_5=./id-card.jpg
jinshuju form theme set Kp7mQ2 --wallpaper ./bg.png
```

```bash
jinshuju entry import --form Kp7mQ2 ./signups.xlsx --map field_1=Name --wait   # wait for it; non-zero exit on failure
jinshuju entry import-status --form Kp7mQ2 <job-id>                            # or look it up later
```

`--map` takes a field api_code on the left and a **column name or column
number** on the right (a bare number is read as a position). Everything knowable
up front is checked before the import starts — the file, the size your plan
allows, the header row, the column mapping — so a rejected import has written
nothing, and the error names the sheet's actual layout. Once accepted, the rows
are written in the background: the command returning means **started**, not
finished.

That is what `--wait` is for. It waits for the job to settle, reports how many
rows were written, skipped and rejected, and **exits non-zero on failure**.
Without it a failed import is invisible — the command succeeds and not a single
row is written. After the fact, `entry import-status` answers the same question
from a job id.

## Progress

Long-running commands (`--all` paging, uploads, `--wait`) report progress.
Progress is written **to stderr, and only when stderr is a terminal**, so
`--output json | jq` receives exactly the same bytes it would without it: a pipe,
or an agent on the other end, never sees a stray character.

## Before removing a field

```bash
jinshuju field check --form Kp7mQ2 field_3 field_7:choice_1
jinshuju field preview-convert --form Kp7mQ2 field_1 --to RadioButton
```

`field check` answers whether a field or a choice has data under it — removing
it takes that data along, so it is worth asking first. `preview-convert` reports
how much a type conversion would keep and how much it would clear.

## Odds and ends

```bash
jinshuju form list --name signup --name survey   # several keywords match any, not one joined phrase
jinshuju entry list --form Kp7mQ2 --labels       # carry the field label with each value, saving a form read
jinshuju table move Vn4xR8 --folder Nf7mDC       # a table only goes into a kind=table folder
jinshuju table create --json @t.json --with-default-entries   # seed a few blank rows, as the web UI does
```

## Token format

Form, table and view tokens are **six characters of mixed-case letters and
digits**, for example `Kp7mQ2`, `Vn4xR8`, `aB3dE9`. Examples here and in
`--help` use that shape throughout.

## Development

```bash
npm install
npm test
npm run typecheck
```
