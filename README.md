# @jinshuju/cli

金数据开放 API v1 命令行工具。

## 安装

```bash
npm install -g @jinshuju/cli
```

安装后提供两个等价入口：

```bash
jinshuju --help
jsj --help
```

## 认证

支持三种凭证：访问令牌（Personal / Account Access Token）、API Key + Secret、浏览器登录。

写入配置文件（`~/.jinshuju/config.json`，权限 600）：

```bash
jinshuju config set access_token xxx     # 访问令牌
jinshuju config set api_key xxx          # 或 API Key / Secret
jinshuju config set api_secret xxx
```

也可以用环境变量，适合 CI 和脚本：

```bash
export JINSHUJU_ACCESS_TOKEN=xxx
# 或
export JINSHUJU_API_KEY=xxx
export JINSHUJU_API_SECRET=xxx
```

三种凭证的**优先级**：访问令牌 > API Key / Secret > 浏览器登录（`jinshuju auth login`）。
显式配置的凭证压过存下来的登录态——设了令牌却用上周的登录，是不该发生的意外。
当前用的是哪个、从哪来，看 `jinshuju auth status`：

```
$ jinshuju auth status
Authenticated with an access token (from env).
```

访问令牌在 `config get` 里和其他密钥一样默认打码，`--show-secret` 才完整显示。

## 创建表单

字段 `type` 使用 API v1 类型名，创建字段时不要传 `api_code`，后端会生成。

```bash
jinshuju form create --json '{
  "name": "活动报名表",
  "fields": [
    { "type": "TextField", "label": "姓名", "required": true },
    { "type": "MobileField", "label": "手机号", "required": true }
  ]
}'
```

## 读数据

`entry`、`view`、`field`、`comment` 都是一级资源，归属用 `--form` / `--table` 表达
（两者互斥，都对应 API 的 `form_token`）。

```bash
jinshuju entry list --form Kp7mQ2
jinshuju entry list --table Vn4xR8
jinshuju entry get 1 --form Kp7mQ2
jinshuju entry list --form Kp7mQ2 --view aB3dE9
```

筛选、排序、翻页：

```bash
jinshuju entry list --form Kp7mQ2 --filter 'field_3 gte 80'
jinshuju entry list --form Kp7mQ2 --filter 'created_at within_last 30d' --filter 'field_9 not_null'
jinshuju entry list --form Kp7mQ2 --sort created_at:desc
jinshuju entry list --form Kp7mQ2 --limit 10
jinshuju entry list --form Kp7mQ2 --all
```

`--limit`只能往小了要：列表的默认页大小同时也是上限（多数是 50），超了按上限算。

`--filter` 可重复，多个条件为 AND。表达不了的条件用 `--filters <json|@file>`。
游标是不透明字符串，把上次响应里的 `next` 原样传回即可。

## 创建 entry

payload 的键是字段 `api_code`，不是字段名。`--json` 支持内联、`@文件` 和 `-`（stdin）。

```bash
jinshuju entry create --form Kp7mQ2 --json '{
  "field_1": "张三",
  "field_2": "13800138000"
}'

jinshuju entry create --form Kp7mQ2 --json @entry.json
cat entry.json | jinshuju entry create --form Kp7mQ2 --json -
```

## Token 格式

表单、表格、视图的 token 都是**六位大小写字母加数字**，例如 `Kp7mQ2`、`Vn4xR8`、`aB3dE9`。
文档和 `--help` 里的示例统一用这个形状。

## 开发

```bash
npm install
npm test
npm run typecheck
```
