---
title: Sky Tool
emoji: 🛠️
colorFrom: blue
colorTo: purple
sdk: docker
pinned: false
license: mit
---

# 晴空工具箱

一个面向微信小程序的全能工具箱项目，覆盖图片处理、PDF/文档、OCR 和日常效率工具。当前仓库已经包含原生小程序前端、可直接启动的 Node.js 后端，以及可选的 MongoDB 持久化和七牛云 Kodo 文件存储接入。

## 当前可用能力

### 小程序端可直接使用

- 图片压缩
- 图片格式转换
- 图片改尺寸
- 基础版证件照
- 图片转 PDF
- 二维码生成
- 单位换算

### 启动后端后可使用

- PDF 合并
- PDF 拆分
- PDF 基础压缩优化
- 图片 OCR 提取文字

### 安装 LibreOffice 后可使用

- Office 转 PDF

## 项目结构

```text
.
|-- app.json
|-- pages/                  # 小程序页面
|-- services/               # 小程序云服务请求层
|-- utils/                  # 任务中心、工具执行逻辑
|-- data/                   # 工具与分类配置
|-- backend/
|   |-- server.js           # Express 服务入口
|   |-- cleanup.js          # 本地过期文件清理脚本
|   `-- lib/
|       |-- config.js       # 运行配置
|       |-- storage.js      # 本地/七牛云存储抽象
|       `-- repository.js   # 本地文件/MongoDB 持久化抽象
`-- Dockerfile
```

## 本地启动

### 1. 安装依赖

```bash
npm install
```

### 2. 启动后端

```bash
npm run backend:start
```

默认地址为 `http://127.0.0.1:3100`。

### 3. 小程序连接后端

1. 用微信开发者工具导入当前目录
2. 打开小程序中的“我的 -> 云服务”
3. 填入后端地址，例如 `http://127.0.0.1:3100`
4. 如果后端启用了 `API_TOKEN`，同时填入 token

## 环境变量

复制 `.env.example` 后按需填写：

```bash
HOST=0.0.0.0
PORT=3100
PUBLIC_BASE_URL=http://127.0.0.1:3100
API_TOKEN=
FILE_TTL_HOURS=24
SOFFICE_PATH=
MONGODB_URI=
MONGODB_DB_NAME=sky_toolbox
MONGODB_COLLECTION_NAME=operation_logs
QINIU_ACCESS_KEY=
QINIU_SECRET_KEY=
QINIU_BUCKET=
QINIU_REGION=
QINIU_PREFIX=sky-toolbox
QINIU_PUBLIC_BASE_URL=
QINIU_PRIVATE_BUCKET=false
QINIU_DOWNLOAD_EXPIRES_SECONDS=3600
```

## MongoDB 与七牛云说明

### MongoDB

配置 `MONGODB_URI` 后，后端会把任务执行日志写入 MongoDB。

- 默认数据库：`sky_toolbox`
- 默认集合：`operation_logs`
- 若 MongoDB 写入失败，会自动回退到本地 `backend/storage/operations.ndjson`

### 七牛云 Kodo

配置以下环境变量后，结果文件会优先保存到七牛云：

- `QINIU_ACCESS_KEY`
- `QINIU_SECRET_KEY`
- `QINIU_BUCKET`
- `QINIU_PUBLIC_BASE_URL`

可选项：

- `QINIU_REGION`：空间区域 ID，例如华南 `z2`。不填时 SDK 会尝试自动查询空间区域。
- `QINIU_PREFIX`：对象前缀，默认 `sky-toolbox`
- `QINIU_PRIVATE_BUCKET`：私有空间填 `true`，后端会生成 `/files/qiniu?key=...` 代理下载地址。
- `QINIU_DOWNLOAD_EXPIRES_SECONDS`：私有空间代理下载签名有效期，默认 `3600`

`QINIU_PUBLIC_BASE_URL` 填七牛空间绑定的访问域名或 CDN 域名，例如 `https://cdn.example.com`。公开空间会直接返回该域名下的文件地址；私有空间会通过后端代理下载。

## 健康检查

后端提供：

```text
GET /health
```

返回内容包含：

- 当前是否要求鉴权
- 文件保留时长
- 可用能力列表
- 存储提供方：`local` 或 `qiniu`
- 日志持久化提供方：`local-file` 或 `mongodb`
- LibreOffice 是否可用

## Office 转 PDF

`Office -> PDF` 依赖 LibreOffice：

- Windows：安装 LibreOffice，并设置 `SOFFICE_PATH`
- Linux：安装 `libreoffice`，通常 `which soffice` 可自动识别

未安装时，健康检查中的 `officeToPdf` 会是 `false`，接口会返回 `501`。

## PDF 转 Word

`PDF 转 Word` 通过 Adobe PDF Services API 的 Export PDF 能力将 PDF 转换为 DOCX，尽量保留原 PDF 版式、字体、表格和图片。

需要在后端环境变量中配置：

- `PDF_SERVICES_CLIENT_ID`
- `PDF_SERVICES_CLIENT_SECRET`

可以参考仓库根目录的 `.env.example`。

可选配置：

- `PDF_SERVICES_REGION`：`US` 或 `EU`，默认使用 Adobe SDK 的默认区域。
- `PDF_SERVICES_OCR_LOCALE`：Export PDF OCR 语言，默认 `zh-CN`。英文文档可设为 `en-US`，日文可设为 `ja-JP`。
- `PDF_SERVICES_TIMEOUT_MS`：Adobe SDK 请求超时时间，默认 `120000`。

如果 PDF 有打开密码，接口请求体可传 `password` 或 `pdfPassword`，后端会先通过 Adobe Remove Protection 再导出 DOCX。

## 清理策略

后端启动时会自动清理超过 `FILE_TTL_HOURS` 的本地输出文件。

也可以手动执行：

```bash
npm run backend:cleanup
```

注意：该脚本只会清理本地输出目录，不会删除七牛云中的对象。

## Docker

当前 `Dockerfile` 可直接启动基础后端：

```bash
docker build -t sky-toolbox .
docker run --env-file .env -p 3100:3100 sky-toolbox
```

如果你希望在容器里使用 Office 转 PDF，需要额外安装 LibreOffice，建议单独做带 LibreOffice 的镜像版本。

也可以直接使用：

```bash
docker compose up -d --build
```

对应配置文件见 `docker-compose.yml`。

## PM2

如果你更习惯直接在服务器上跑 Node 进程，可以使用仓库内的 `ecosystem.config.js`：

```bash
pm2 start ecosystem.config.js
pm2 save
```

## Nginx 反向代理

仓库已附带一个基础示例：

```text
deploy/nginx.sky-toolbox.conf.example
```

这个配置已经包含了：

- 100MB 上传体积限制
- 转发真实客户端 IP
- 适合 PDF/OCR 任务的较长超时时间

## 建议的上线配置

要让真机用户可直接使用，建议准备：

- 一个可公网访问且已备案的后端域名
- 微信小程序合法 request/download 域名配置
- 一个 MongoDB 实例，用于任务日志与运维排查
- 一个七牛云 Kodo 空间，用于结果文件存储
- 可选的 LibreOffice 运行环境，用于 Office 转 PDF

## 已验证项

- 后端健康检查可返回能力、存储和持久化状态
- PDF 合并、PDF 拆分、PDF 压缩接口可实际执行
- OCR 接口可返回文本结果
- 小程序端可接入远程结果并在任务详情页打开、下载、复制

## 下一步建议

- 接入微信登录和用户体系
- 接入真实支付、积分消耗和会员权益
- 把任务中心从本地存储升级为服务端同步
- 为七牛云增加 CDN 域名和生命周期清理规则
- 为文档类工具增加异步队列和失败重试

