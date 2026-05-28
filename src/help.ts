export const rootHelp = `Usage: jinshuju <command> [options]

Commands:
  auth login                  Sign in with Web OAuth (PKCE)
  auth status                 Check authentication status
  auth refresh                Refresh OAuth token
  auth logout                 Revoke and clear OAuth session
  config get [key]            Show local CLI configuration
  config set <key> <value>    Set local CLI configuration
  config unset <key>          Remove local CLI configuration
  form list                   List forms
  form get <form-token>       Get form schema by token
  form create                 Create a form from API v1 JSON payload
  form entry <command>        Manage form entries
  form view <command>         Manage form views

Options:
  --api-key <key>             Override API key
  --api-secret <secret>       Override API secret
  --config <path>             Config path, default ~/.jinshuju/config.json
  --output <format>           text, json; default text
  -h, --help                  Show help
  -v, --version               Show version

Notes:
  Use jinshuju auth login for interactive Web OAuth, or API Key / Secret for scripts.
`;

export const helpByCommand = new Map<string, string>([
  ['auth login', `Usage: jinshuju auth login [options]

Sign in with Web OAuth using Authorization Code + PKCE and a loopback callback.

Options:
  --host <url>                 API host, default https://jinshuju.net
  --auth-host <url>            OAuth host, default https://account.jinshuju.net
  --client-id <id>             OAuth public client id
  --scopes <scopes>            Space-separated OAuth scopes
  --no-open                    Print login URL instead of opening browser
  --config <path>              Config path
  --output <format>            text, json; default text
  -h, --help                   Show help

Environment:
  JINSHUJU_OAUTH_CLIENT_ID
  JINSHUJU_AUTH_HOST
  JINSHUJU_HOST

Examples:
  jinshuju auth login --client-id YOUR_PUBLIC_CLIENT_ID
  jinshuju auth login --auth-host https://account.jinshuju.net --host https://jinshuju.net
`],
  ['auth status', `Usage: jinshuju auth status [options]

Check whether OAuth or API Key / Secret authentication is available.

Options:
  --verify                    Verify credentials with a lightweight API call
  --output <format>           text, json; default text
  -h, --help                  Show help

Environment:
  JINSHUJU_API_KEY
  JINSHUJU_API_SECRET
  JINSHUJU_OAUTH_CLIENT_ID
  JINSHUJU_HOST
  JINSHUJU_AUTH_HOST

Examples:
  jinshuju auth status
  jinshuju auth status --verify
  jinshuju auth status --output json

Notes:
  API Key / Secret stays supported for scripts. OAuth sessions are stored locally.
`],
  ['auth refresh', `Usage: jinshuju auth refresh [options]

Refresh the saved OAuth access token using the refresh token.

Options:
  --config <path>              Config path
  --output <format>            text, json; default text
  -h, --help                   Show help
`],
  ['auth logout', `Usage: jinshuju auth logout [options]

Revoke the current OAuth access token and clear the local OAuth session.

Options:
  --config <path>              Config path
  --output <format>            text, json; default text
  -h, --help                   Show help
`],
  ['config get', `Usage: jinshuju config get [key] [options]

Show local CLI configuration. Secret values are masked by default.

Arguments:
  key                         Optional: api_key, api_secret

Options:
  --show-secret               Show secret values without masking
  --config <path>             Config path
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju config get
  jinshuju config get api_key
`],
  ['config set', `Usage: jinshuju config set <key> <value> [options]

Set local CLI configuration.

Arguments:
  key                         api_key or api_secret
  value                       Config value

Options:
  --config <path>             Config path
  -h, --help                  Show help

Examples:
  jinshuju config set api_key YOUR_API_KEY
  jinshuju config set api_secret YOUR_API_SECRET
`],
  ['config unset', `Usage: jinshuju config unset <key> [options]

Remove local CLI configuration.

Arguments:
  key                         api_key or api_secret

Options:
  --config <path>             Config path
  -h, --help                  Show help

Examples:
  jinshuju config unset api_secret
`],
  ['form list', `Usage: jinshuju form list [options]

List forms accessible to current credentials.

Options:
  --next <cursor>             API v1 pagination cursor from previous response
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form list
  jinshuju form list --output json
`],
  ['form get', `Usage: jinshuju form get <form-token> [options]

Get form schema by token.

Arguments:
  form-token                  Form token, for example q1234567890

Options:
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form get q1234567890
  jinshuju form get q1234567890 --output json
`],
  ['form create', `Usage: jinshuju form create --json <json> [options]

Create a form from API v1 JSON payload.

Options:
  --json <json>               Inline JSON payload
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form create --json '{
    "name": "活动报名表",
    "fields": [
      { "type": "TextField", "label": "姓名", "required": true },
      { "type": "MobileField", "label": "手机号", "required": true }
    ]
  }'

API:
  POST https://jinshuju.net/api/v1/forms

Notes:
  Do not pass api_code when creating fields. Field api_code is generated by backend.
  Field type must use API v1 names such as TextField, MobileField, RadioButton.
`],
  ['form entry list', `Usage: jinshuju form entry list <form-token> [options]

List entries of a form.

Arguments:
  form-token                  Form token, for example q1234567890

Options:
  --next <cursor>             API v1 pagination cursor from previous response
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form entry list q1234567890
`],
  ['form entry get', `Usage: jinshuju form entry get <form-token> <entry-serial-number> [options]

Get a single entry.

Arguments:
  form-token                  Form token, for example q1234567890
  entry-serial-number         Entry serial number, for example 1

Options:
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form entry get q1234567890 1
`],
  ['form entry create', `Usage: jinshuju form entry create <form-token> --json <json> [options]

Create an entry in a form.

Arguments:
  form-token                  Form token, for example q1234567890

Options:
  --json <json>               Entry data payload
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form entry create q1234567890 --json '{
    "field_1": "张三",
    "field_2": "13800138000"
  }'

Notes:
  Entry payload keys are backend-generated field api_code values.
`],
  ['form view list', `Usage: jinshuju form view list <form-token> [options]

List views of a form.

Arguments:
  form-token                  Form token, for example q1234567890

Options:
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form view list q1234567890
`],
  ['form view get', `Usage: jinshuju form view get <form-token> <view-token> [options]

Get a form view.

Arguments:
  form-token                  Form token, for example q1234567890
  view-token                  Six-character alphanumeric token, for example aB3dE9

Options:
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form view get q1234567890 aB3dE9
`],
  ['form view entry list', `Usage: jinshuju form view entry list <form-token> <view-token> [options]

List entries visible in a specific form view.

Arguments:
  form-token                  Form token, for example q1234567890
  view-token                  Six-character alphanumeric token, for example aB3dE9

Options:
  --next <cursor>             API v1 pagination cursor from previous response
  --output <format>           text, json; default text
  -h, --help                  Show help

Examples:
  jinshuju form view entry list q1234567890 aB3dE9
`]
]);
