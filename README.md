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
jinshuju form create --json @form.json --scene registry --layout card --folder Fd2xK8
jinshuju form create --json @exam.json --type exam        # 载荷里可带 exam_setting
jinshuju form edit Kp7mQ2 --json '{"exam_setting":{"limited_time":45}}'

jinshuju form create --json '{
  "name": "活动报名表",
  "fields": [
    { "type": "TextField", "label": "姓名", "required": true },
    { "type": "MobileField", "label": "手机号", "required": true }
  ]
}'
```

`--type exam` / `--type evaluation` 同时决定场景和它专属的设置块。那个设置块有自己的端点，
所以带它的载荷是两次请求——而且**通用的表单更新根本不认这个键**（它只读 name、description、
setting、fields、field_rules），不分派的话 `exam_setting` 会被静默丢掉。

设置块总是先发：它是可能因「这不是考试表单」被拒的那一半，先发才能保证被拒时其余改动一律没发生。

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

## 数据分析

不用把数据拉回来自己算——计数、聚合、画像都在服务端做，返回体的大小只取决于问了几个指标、分了几组。

```bash
jinshuju entry count --form Kp7mQ2 --filter 'field_3 gte 80'
jinshuju entry count --form Kp7mQ2 --form Vn4xR8            # 容器可重复，最多 10 个

jinshuju entry aggregate --form Kp7mQ2 --metric avg:field_3
jinshuju entry aggregate --form Kp7mQ2 --metric count:field_1 --by created_at:month --limit 12

jinshuju entry summary --form Kp7mQ2
jinshuju entry summary --form Kp7mQ2 --fields field_3,field_7 --no-overview
```

`--metric <func>:<field>` 可重复，1–20 个；`--by <field>[:day|week|month]` 最多 2 个，日期维度必须带分桶。
某个字段支持哪些函数是字段自己说的，看 `form get` 里的 `analytics.agg_funcs`。
多容器计数不接受 `--keyword`，`--filter` 只能用 `created_at` / `updated_at` / `creator_id`——
一个 api_code 在每张表上都是不同的字段，跨表比较没有意义。

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

## 写

每条写命令都只发一次请求，payload 的键是字段 `api_code`。

```bash
jinshuju folder create 台账 --kind table          # 文件夹分 form / table，表格进不了表单夹
jinshuju form edit Kp7mQ2 --json '{"name":"2026 活动报名"}'
jinshuju form copy Kp7mQ2 --name 副本
jinshuju form move Kp7mQ2 --folder Fd2xK8         # 不带 --folder 就是移出文件夹
jinshuju form theme set Kp7mQ2 --primary-color "#1F6FEB"
jinshuju table create --json @table.json --folder Nf7mDC
jinshuju table edit Vn4xR8 --json '{"name":"2026 台账"}'
```

字段的增删改都落在容器的一次 PATCH 上：

```bash
jinshuju field add --form Kp7mQ2 --json '{"type":"TextField","label":"备注"}'
jinshuju field update --form Kp7mQ2 field_3 --json '{"required":true}'
jinshuju field update-choices --form Kp7mQ2 field_7 --json '{"add":[{"label":"丙"}]}'
jinshuju field remove --form Kp7mQ2 field_9 --yes
```

数据与视图：

```bash
jinshuju entry create --form Kp7mQ2 --batch @entries.json
jinshuju entry update --form Kp7mQ2 12 --json '{"field_2":99}'          # 合并
jinshuju entry update --form Kp7mQ2 12 --replace --json '{"field_1":"李四"}'  # 整条覆盖，没给的清空
jinshuju entry update --form Kp7mQ2 --batch @rows.json                  # [{serial_number, entry}]
jinshuju entry delete --form Kp7mQ2 12 --yes

jinshuju view create --form Kp7mQ2 高分 --filter 'field_3 gte 80' --sort created_at:desc
jinshuju comment create --form Kp7mQ2 --entry 12 "已联系，等回复"
jinshuju opensearch edit Qy7nR3 --disable
```

删除一律要 `--yes`。这个 CLI 不交互——stdin 留给 `--json -`——所以确认是个 flag，
不给就不删，而不是抛一个没人回答的问题。

## 跨表单

```bash
jinshuju entry search 某某公司                        # 我能读到的所有表单和表格，最多 10 个
jinshuju entry search 13800138000 --form Kp7mQ2 --form Vn4xR8
jinshuju entry search 报修 --scope-filter 'entries_count gt 100'   # 筛「搜哪些表单」，不筛数据

jinshuju entry stats --from 2026-09-01               # 每张表单这段时间收到多少条
jinshuju entry stats --from 2026-09-01 --to 2026-09-07 --kind form --limit 10
```

搜不到的表单会被**留在结果里并注明原因**，而不是当成「没匹配」丢掉——「没搜」和「没有」不是一回事。
`entry stats` 和 `entry count` 口径不同：前者是「来了多少」（导入按运行那天记，删除不扣减），
后者是「现在还剩多少」。

## 我填写的

```bash
jinshuju form list --mine                      # 我填过哪些表单（不是我拥有的）
jinshuju entry list --form Kp7mQ2 --mine       # 我在这张表单里提交过什么
jinshuju entry search 某某公司 --mine           # 我提交过的数据里有没有它
```

范围钉死在自己的提交上，读不到别人的，也不需要对那张表单有任何权限。
只在 owner 视角成立的 flag（`--sort` / `--view` / `--scope-filter` 等）跟 `--mine` 一起给会被拒绝。

## 传文件

三条要传文件的命令。CLI 直接用自己的凭证上传，不需要先去换一张票据。

```bash
jinshuju entry import --form Kp7mQ2 ./报名.xlsx --map field_1=姓名 --map field_2=手机号
jinshuju entry import --table Vn4xR8 ./rows.csv --map field_1=1 --map field_2=2 --header-row 2 --unique field_1

jinshuju entry create --form Kp7mQ2 --json '{"field_1":"张三"}' --attach field_5=./身份证.jpg
jinshuju form theme set Kp7mQ2 --wallpaper ./bg.png
```

```bash
jinshuju entry import --form Kp7mQ2 ./报名.xlsx --map field_1=姓名 --wait   # 等它写完，失败则退出码非 0
jinshuju entry import-status --form Kp7mQ2 <job-id>                        # 事后查
```

`--map` 左边是字段 api_code，右边是**列名或列序号**（纯数字按序号）。
导入前该查的都会先查——文件、套餐允许的大小、表头行、列映射——所以被拒的导入一行都没写，
报错里还会带上表格真实的列布局。通过之后行是后台写的：命令返回代表**已启动**，不代表已完成。

所以有 `--wait`：它等到写完，报告写了多少、跳过多少、拒了多少，**失败时退出码非 0**。
不加 `--wait` 的话导入失败是看不见的——命令成功返回，行却一条都没写。事后也可以用
`entry import-status` 拿 job id 查。

## 进度显示

耗时的命令（`--all` 翻页、上传、`--wait` 等待）会显示进度。进度**只写 stderr，且只在 stderr
是终端时才写**——所以 `--output json | jq` 拿到的字节和没有进度时完全一样，管道和 agent
那边一个多余字符都不会有。

## 删字段之前

```bash
jinshuju field check --form Kp7mQ2 field_3 field_7:choice_1
jinshuju field preview-convert --form Kp7mQ2 field_1 --to RadioButton
```

`field check` 回答「这个字段/选项底下有没有数据」——删了就连数据一起没了，删之前先问一句。
`preview-convert` 报告类型转换会保留多少、清掉多少。

## 其他

```bash
jinshuju form list --name 报名 --name 问卷       # 多个关键词是「任意匹配」，不是拼成一个词
jinshuju entry list --form Kp7mQ2 --labels       # 每个值带上字段名，省一次读表单
jinshuju table move Vn4xR8 --folder Nf7mDC       # 表格只能进 kind=table 的文件夹
jinshuju table create --json @t.json --with-default-entries   # 播几行空行，跟界面上建表一样
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
