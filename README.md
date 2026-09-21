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

第一版只支持 API Key / API Secret。

```bash
export JINSHUJU_API_KEY=xxx
export JINSHUJU_API_SECRET=xxx
```

或写入配置文件：

```bash
jinshuju config set api_key xxx
jinshuju config set api_secret xxx
```

`login` / `logout` 不属于第一版 API Key / Secret 模式，后续 Web OAuth 再支持。

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
jinshuju entry list --form Kp7mQ2 --all
```

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
