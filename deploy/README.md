# Docker 镜像部署

交付包面向 Linux amd64（x86_64）服务器，需要已安装 Docker 和 Docker Compose。不需要 Node.js、源码或数据库。

## 首次部署

将交付包传到服务器并解压，在解压目录执行：

```bash
docker load -i image.tar
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，填写：

```dotenv
PUBLIC_ORIGIN=https://你的正式域名
ADDITIONAL_ORIGINS=
COOKIE_SECURE=true
HR_PORTAL_ENABLED=true
DINGTALK_APP_KEY=现有应用的AppKey
DINGTALK_APP_SECRET=现有应用的AppSecret
DINGTALK_BASE_ID=现有AI表格文档ID
DINGTALK_SHEET_ID_OR_NAME=数据表ID或名称
DINGTALK_OPERATOR_ID=有编辑权限的操作人unionId
```

也可安全复制当前项目的 `.env` 后调整域名。真实凭据未包含在交付包或镜像中。

将域名解析到服务器，配置 HTTPS。把 `nginx.conf.example` 中的 `location /` 配置放入该域名的 HTTPS server，转发到 `127.0.0.1:8082`；对外开放 80、443 端口。服务器需要能访问原站 `bigfivepersonality.me` 和钉钉 API。

在原钉钉应用中添加新的完整 OAuth 回调地址：

```text
https://你的正式域名/auth/dingtalk/callback
```

启动并检查：

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=50
```

访问正式网址，验证钉钉登录、登记、邀请测评和结果回填。

## 更新与数据保留

导入新交付包的镜像后，在原部署目录保留 `.env` 并执行：

```bash
docker load -i image.tar
docker compose up -d --force-recreate
```

仅修改 `.env` 时同样需要 `--force-recreate`，单纯 restart 不会加载新配置。

持久卷为 `bigfive-nesting-v2_nesting-tasks`，保存加密邀请、登录会话、重试任务和去重回执。迁移现有服务时，先停止旧服务，完整备份并恢复该卷（包括 `session.key`，保留文件权限），再启动新服务。不要执行 `docker compose down -v`。只运行一个服务实例。

旧邀请包含旧域名，需让旧地址继续访问新服务；建议进行中的测评完成后再切换。独立全新部署可创建空卷。

## 重新打包

仓库内执行 `bash scripts/package-image.sh`。镜像仅包含服务运行文件；部署包不包含测试、截图、真实凭据或本机任务数据。输出在 `dist/`，默认构建 linux/amd64 镜像。
