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

## 创建 entry

entry payload 使用后端返回 / 生成的字段 `api_code` 作为 key。

```bash
jinshuju form entry create q1234567890 --json '{
  "field_1": "张三",
  "field_2": "13800138000"
}'
```

## View entry

表单 view token 示例统一使用六位字母数字。

```bash
jinshuju form view entry list q1234567890 aB3dE9
```

## 开发

```bash
npm install
npm test
npm run typecheck
```
