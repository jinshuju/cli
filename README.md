# @jinshuju/cli

[![npm](https://img.shields.io/npm/v/@jinshuju/cli)](https://www.npmjs.com/package/@jinshuju/cli)

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

Two kinds of credential are supported: an interactive browser login (OAuth),
and an access token (personal or account). Both go in through `auth login`:

```bash
jinshuju auth login                          # browser login
jinshuju auth login --device                 # approve a short code on any other device
jinshuju auth login --access-token xxx       # access token, checked before it is stored
```

On a machine without a browser — a server over SSH, a container, an agent's
sandbox — `--device` prints a link and a short code. Open the link on any
device, a phone will do, check the code matches and approve; the CLI is
polling and finishes on its own. Nothing has to reach back into the machine.
Over SSH, or on Linux without a display, `auth login` does this by itself.
Someone without an account can sign up on that page and come back to approve.

An agent whose commands are cut off after a minute or two can split it in
two:

```bash
jinshuju auth login --no-wait --output json  # prints verification_uri_complete and user_code, then exits
jinshuju auth login --resume --timeout 60    # waits up to 60s; exit code 9 means still pending
```

Either one is written to the config file (`~/.jinshuju/config.json`, mode 600)
and replaces whatever credential was stored before. `jinshuju auth logout`
forgets it (revoking it first, for a browser session).

For CI and scripts, an environment variable works without touching the file:

```bash
export JINSHUJU_ACCESS_TOKEN=xxx
```

The **precedence** is `JINSHUJU_ACCESS_TOKEN`, then the stored credential. A
token set for this run always beats a stored login: acting as last week's
login instead is a surprise nobody wants. `jinshuju auth status` reports which
credential is in use and where it came from:

```
$ jinshuju auth status
Authenticated with an access token (from env).
```

`config set` holds only `host`, `auth_host` and `client_id`; credentials are
not config.

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

### When the form takes entries

`setting` travels as is, on create and on edit. Its close rules decide when the
form is open; they coexist, and `form get` reads them back in the shape they
were written. On edit a rule replaces what was there (`time_periods` is the
whole list). A time-range, daily or entries rule is removed by
`{"enabled": false}` or by `null`. `manually_close_rule` is a switch rather
than a rule: `{"closed": false}` reopens the form, and changing `closed` either
way deletes the other three rules.

```bash
# between two instants; either end may be left out
jinshuju form edit Kp7mQ2 --json '{"setting":{"by_time_range_close_rule":{"start_time":"2026-10-01T09:00:00+08:00","end_time":"2026-10-07T18:00:00+08:00"}}}'
# 11:00-12:40 and 17:00-18:30, every day
jinshuju form edit Kp7mQ2 --json '{"setting":{"daily_repeat_close_rule":{"time_periods":[
  {"start_time":{"hour":11,"minute":0},"end_time":{"hour":12,"minute":40}},
  {"start_time":{"hour":17,"minute":0},"end_time":{"hour":18,"minute":30}}]}}}'
jinshuju form edit Kp7mQ2 --json '{"setting":{"daily_repeat_close_rule":{"enabled":false}}}'
jinshuju form edit Kp7mQ2 --json '{"setting":{"by_entries_close_rule":{"limit":100}}}'   # closes after 100 entries
jinshuju form edit Kp7mQ2 --json '{"setting":{"by_entries_close_rule":null}}'            # takes the limit off
jinshuju form edit Kp7mQ2 --json '{"setting":{"manually_close_rule":{"closed":true}}}'   # stops it now
jinshuju form edit Kp7mQ2 --json '{"setting":{"manually_close_rule":{"closed":false}}}'  # reopens it
```

`show_form_before_open` and `show_close_count_down` only hold with a time-range
or daily rule; without one the save resets them to false.

## Reading data

`entry`, `view`, `field` and `comment` are all top-level resources; the
container is given by `--form` or `--table` (mutually exclusive, both mapping to
the API's `form_token`).

```bash
jinshuju entry list --form Kp7mQ2
jinshuju entry list --table Vn4xR8
jinshuju entry get 1 --form Kp7mQ2
jinshuju entry list --form Kp7mQ2 --view aB3dE9
jinshuju folder get Fd2xK8                       # the folder a form or table's folder_token names
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

`--all` reads at most 200 pages. Past that it stops with an error naming the
cursor; pass it to `--next` (with `--all` again) to read on.

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

jinshuju entry count --form Kp7mQ2 --view aB3dE9 --filter 'field_3 gte 80'   # only what the view shows
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

Creating, updating or getting one entry answers with a `url`: where that entry
opens in the Jinshuju data page, for whoever wrote it to check it there. A
`--batch` write answers without one.

## Writing

Apart from the settings-block dispatch described above, every write command
issues exactly one request, and payload keys are field `api_code`s.

```bash
jinshuju folder create Ledgers --kind table       # folders are form or table; a table cannot go in a form folder
jinshuju form edit Kp7mQ2 --json '{"name":"2026 signups"}'
jinshuju form copy Kp7mQ2 --name Copy
jinshuju form copy Kp7mQ2 --name 第二期 --with-notification-rules
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
jinshuju checkin create --form Kp7mQ2             # needs the check-in plugin enabled for the account
jinshuju checkin edit 42 --disable
jinshuju notification create --form Kp7mQ2 --approach SMS --recipients field_2 --template-id 6650a1 --placeholder field_1
jinshuju notification list --form Kp7mQ2             # each rule says whether it can send, and why not
jinshuju notification log 6650b2 --form Kp7mQ2 --from 2026-10-01   # what the rule sent: how many succeeded, failed, and why
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
jinshuju entry stats --from 2026-09-28 --by day       # the same, split into each day, in one call
jinshuju entry stats --from 2026-01-01 --by month     # or by week / month: at most 92 days, 53 weeks, 24 months
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

## Filling in someone else's form

A fill link — `…/f/<token>` for a form, `…/v/<token>` for a table's form view —
can be filled from the CLI the way anyone with the link fills it in a browser:

```bash
jinshuju fill get https://acme.jinshuju.net/v/aB3dE9                          # what it asks for, and whether you can submit
jinshuju fill submit https://acme.jinshuju.net/v/aB3dE9 --json '{"field_1":"Ada"}'
```

No role on the form is needed, and only what the page shows its fillers comes
back. The entry is recorded as yours. A page that asks for something only the
person at it can do — a captcha, an SMS code, WeChat, a payment — lists it under
`blockers`, and is refused until it is filled in a browser. An OAuth session
needs the `submit_entries` scope for these.

## Routines (自动任务)

A routine is an instruction Jiri carries out on a schedule, or when the data of
a form or table changes. One created here is active at once, the same as one
created on the 自动任务 page, and is held to that page's rules and words.

```bash
jinshuju routine create --name 每周报名汇总 --description 每周一汇总上周报名，按渠道统计 \
  --instruction '汇总上周报名表新增的数据' --object form:Kp7mQ2 --schedule 'weekly 1 09:00'
jinshuju routine create --json @routine.json         # an event trigger and its conditions
jinshuju routine list --state active
jinshuju routine get 6ac5f0e2b1d4c3a2f1e0d9c8         # trigger_text, next_runs, objects, url
jinshuju routine update 6ac5f0e2b1d4c3a2f1e0d9c8 --schedule 'workdays 08:30'
jinshuju routine pause 6ac5f0e2b1d4c3a2f1e0d9c8
jinshuju routine resume 6ac5f0e2b1d4c3a2f1e0d9c8
jinshuju routine run 6ac5f0e2b1d4c3a2f1e0d9c8          # once, now
jinshuju routine runs 6ac5f0e2b1d4c3a2f1e0d9c8
jinshuju routine delete 6ac5f0e2b1d4c3a2f1e0d9c8 --yes
```

`--schedule` is Beijing time and covers the six frequencies: `once 2026-10-12
09:00`, `hourly 30`, `daily 09:00`, `workdays 09:00`, `weekly 1,5 09:00` (1 is
Monday) and `monthly 1,-1 09:00` (-1 is the last day). `--object kind:token`
names a form, table, view or public query, and given, it is the whole list.
`--description` is the one sentence the routines list shows people, up to 100
characters; the instruction is written for Jiri.
Flags lay over `--json`; `routine create --help` shows the full payload, events
and conditions included. A routine against the page's rules exits 5 with every
reason the page gives.

Letting a routine delete data (`delete_authorized`) is turned on on the
自动任务 page only. There is no flag for it, and a payload naming it, true or
false, is refused before anything is sent — `routine get` answers with it, so
take it out before sending a routine read back. A routine's own run cannot
create or change routines; it may read them.

Routines belong to a person, so an account access token cannot manage them. A
browser login asks for the `routines` OAuth scope; a login made with an older
version has no such scope, and the routine commands answer it with 403 (exit
3). Run `jinshuju auth login` again to get a token that has it.

## Working with files

Seven commands take a file. The CLI uploads with its own credential; there is no
ticket to fetch first.

```bash
jinshuju entry import --form Kp7mQ2 ./signups.xlsx --map field_1=Name --map field_2=Mobile
jinshuju entry import --table Vn4xR8 ./rows.csv --map field_1=1 --map field_2=2 --header-row 2 --unique field_1

jinshuju entry create --form Kp7mQ2 --json '{"field_1":"Alice"}' --attach field_5=./id-card.jpg
jinshuju form theme set Kp7mQ2 --wallpaper ./bg.png
jinshuju opensearch edit Qy7nR3 --header ./banner.png
jinshuju form image upload ./venue-map.png      # answers with a url for an <img> in a form or field description
jinshuju sms signature create 小金培训 --license ./license.jpg --company-name 小金培训有限公司 --company-id 91110000MA00000000 \
  --id-card-front ./front.jpg --id-card-back ./back.jpg --id-card-name 张三 --id-card-number 110101199001011234 --mobile 13800000000
jinshuju sms signature update 6512a1c2d3e4f5a6b7c8d9d3 --license ./license-clear.jpg
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
It gives up after thirty minutes, naming the job so it can still be looked up.
Without it a failed import is invisible — the command succeeds and not a single
row is written. After the fact, `entry import-status` answers the same question
from a job id.

## Line-delimited JSON

`--output jsonl` answers one JSON object per line: a listing becomes its rows,
anything else is one line. With `--all` the rows are written as each page
arrives and nothing is held back, so a listing of any size streams through
`jq -c`, a shell loop or a log shipper without first fitting in memory.

```bash
jinshuju entry list --form Kp7mQ2 --all --output jsonl | jq -c 'select(.field_3 > 80)'
jinshuju entry list --form Kp7mQ2 --all --output jsonl | while read -r row; do …; done
```

Errors are JSON on stderr under `jsonl` exactly as under `json`.

## Progress

Long-running commands (`--all` paging, uploads, `--wait`) report progress.
Progress is written **to stderr, and only when stderr is a terminal**, so
`--output json | jq` receives exactly the same bytes it would without it: a pipe,
or an agent on the other end, never sees a stray character.

## Exit codes

The exit code says what kind of failure it was, so a script can branch without
parsing anything:

| code | meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 0    | done                                                                     |
| 1    | something unexpected; please report it                                   |
| 2    | usage: a flag, argument, input file or unknown command                   |
| 3    | authentication: no credential, or one the server refused (401, 403)      |
| 4    | not found (404)                                                          |
| 5    | refused by the API: validation, conflict, quota (other 4xx)              |
| 6    | the server failed (5xx)                                                  |
| 7    | transport: the connection failed or timed out                            |
| 8    | rate limited: wait and retry; the message and `retry_after` say how long |

With `--output json`, stderr carries the same as JSON, plus the status and body
the server answered with:

```json
{
  "error": {
    "kind": "not_found",
    "message": "form cannot be found",
    "status": 404,
    "body": { "error_description": "form cannot be found" }
  }
}
```

## Timeouts and retries

Every request has a deadline of one minute; `JINSHUJU_TIMEOUT_MS` changes it. A
request the server answers with 429 or 503 is tried again after backing off,
honouring `Retry-After` when it is sent. A read is also retried after a gateway
failure or a dropped connection. A write is not: a POST that timed out may well
have landed, and sending it again would create the entry twice.

## Before removing a field

```bash
jinshuju field check --form Kp7mQ2 field_3 field_7:choice_1
jinshuju field preview-convert --form Kp7mQ2 field_1 --to RadioButton
```

`field check` answers whether a field or a choice has data under it — removing
it takes that data along, so it is worth asking first. `preview-convert` reports
how much a type conversion would keep and how much it would clear.

## SMS signatures and templates

An SMS notification needs a signature and a template, and both wait on a
review, so submit them as early as you can. The materials a signature is
applied with replace your ID card information, and the account's business
license unless the account has passed license verification. A template can go in while its
signature is still under review; `sms status` follows both, with the reason
when one is rejected.

`sms signature list` shows every signature of the account and `sms template list`
your templates with the ones the account shares; both carry the ids the updates
and deletes take. A rejected signature, and a template of yours that is not under
review, can be changed and sent back to review; only the flags given change. The
same ones can be deleted with `--yes`; deleting a signature takes its templates
with it.

While your own are under review, `sms template list --scope official` lists the official
templates, which are approved already and can be sent right away.

```bash
jinshuju sms signature create 小金培训 --license ./license.jpg --company-name 小金培训有限公司 --company-id 91110000MA00000000 \
  --id-card-front ./front.jpg --id-card-back ./back.jpg --id-card-name 张三 --id-card-number 110101199001011234 --mobile 13800000000
jinshuju sms template create --signature 小金培训 --content "你报名的课程明天上午 9 点开课，请准时参加。"
jinshuju sms status
jinshuju sms signature list --status FAIL
jinshuju sms template list --keyword 开课 --scope owned
jinshuju sms template list --scope official
jinshuju sms signature update 6512a1c2d3e4f5a6b7c8d9d3 --license ./license-clear.jpg
jinshuju sms template update 6512a1c2d3e4f5a6b7c8d9e0 --content "你报名的课程后天上午 9 点开课。"
jinshuju sms template delete 6512a1c2d3e4f5a6b7c8d9e0 --yes
```

## Sending SMS and email to entries

`sms send` and `email send` pick the entries of a form the way `entry count`
narrows them, by `--filter`, `--keyword` or `--view`, or the whole form with
`--select-all`, and send to the field `--field` names. Sending uses quota and
cannot be recalled, so each takes `--estimate` or `--yes`: `--estimate` answers
how many entries and recipients it reaches, how many are missing a number or an
address, what it bills and whether the quota covers it, and sends nothing;
`--yes` sends. The entries are picked again when it sends.

An SMS goes out from a template, by the id `sms template list` gives; variables
are filled from the fields `--placeholder` names, one per variable in order.
`--send-at` schedules it and `--manual` holds it for `sms task send`. A task whose
template failed review can be changed with `sms task change`, and a sent one
sent again with `sms task resend` to the entries that got a result.

```bash
jinshuju sms send --form Kp7mQ2 --field field_2 --template-id 6512a1c2d3e4f5a6b7c8d9e0 --filter 'field_5 eq 已报名' --estimate
jinshuju sms send --form Kp7mQ2 --field field_2 --template-id 6512a1c2d3e4f5a6b7c8d9e0 --filter 'field_5 eq 已报名' --yes
jinshuju sms task list --form Kp7mQ2 --from 2026-10-01   # each task with how many numbers succeeded or failed
jinshuju sms task activities 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --status FAILED
jinshuju sms task resend 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --status FAILED --yes
jinshuju email smtp-account list
jinshuju email send --form Kp7mQ2 --field field_3 --select-all --subject 上课提醒 --content '<p>明天上午 9 点开课</p>' --yes
```

## Artifacts

An artifact is a file Jiri made in a conversation. `artifact list` lists the
ones Jiri made for you in the account you are in, newest first, one row per
artifact however many versions it has. Each row carries `conversation_url`,
the Jiri conversation it was made in, and `audience`, who its link is open to
(empty when it was never shared); in `--output json` that is
`published_artifact.allowed_audience`, beside the version the link shows
(`published_version`). The link itself comes from `artifact share get`.
`--name` keeps the artifacts whose title
contains the keyword, case-insensitive; `--limit`, `--next` and `--all` page as
other listings do.

An HTML version can be shared by a link, and `artifact share set` says who can
open it: `private` (only you, the default), `internal` (members of your
account) or `public` (anyone with the link). A plan without share links is
refused with 402 by `artifact share get` and by sharing beyond `private`;
`internal` needs a plan with members-only sharing, and `artifact share get`
says whether the plan has it. The first `get` or `set` creates the link.
`artifact share get` and `--audience private` take the `id` of an
`artifact list` row. `--audience internal` and `public`
bind the link to a version, so `<artifact>` names one: the row's
`latest_version.id` (`version_id` in text), a version token, or the address of
the page that shows the version (`https://…/artifacts/<token>`). The artifact
id is refused there, since its latest version can change before the share is
made. To share another version of the same artifact, name that one.
`--audience private` keeps the version the link shows, whichever version
`<artifact>` names.

An OAuth session needs the `artifacts` scope, which `jinshuju auth login`
asks for; a session from an older CLI has to log in again. An account access
token is refused with 400: an artifact belongs to a person.

```bash
jinshuju artifact list --name 周报
jinshuju artifact share get https://next.jinshuju.net/artifacts/Xy7Qm2PaLk9W
jinshuju artifact share set Xy7Qm2PaLk9W --audience public
jinshuju artifact share set Pq4nR8sT2vWx --audience internal   # now the link shows this version
jinshuju artifact share set Xy7Qm2PaLk9W --audience private    # the link still shows Pq4nR8sT2vWx
```

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

How the code is organised, and why, is in [ARCHITECTURE.md](ARCHITECTURE.md).

```bash
npm install
npm test
npm run check       # typecheck + oxlint + oxfmt --check, what CI runs
npm run fmt         # format in place with oxfmt
npm run generate    # src/generated from spec/openapi.yaml
npm run spec:update # fetch the published openapi.yaml, then generate
```

What a request may carry — paths, parameters, the values a flag takes — follows
`spec/openapi.yaml`, a copy of the published API v1 spec. A daily workflow
fetches it and opens a pull request when it changes.
