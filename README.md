# GitWarp

一个用 Cloudflare Pages Functions 部署的 Docker Registry v2 拉取代理。建议部署成两个 Pages
项目：

- `dhub-23h.pages.dev` -> `registry-1.docker.io`
- `ghcr-6u5.pages.dev` -> `ghcr.io`

项目默认只允许 `GET`、`HEAD`、`OPTIONS`，用于拉取镜像；`POST`、`PUT`、`PATCH`、`DELETE`
会被拒绝。

## 本地开发

先全局安装 Wrangler：

```bash
npm install -g wrangler@4.95.0
```

然后启动对应 registry 的本地代理：

```bash
npm run dev:dockerhub
npm run dev:ghcr
```

## 部署

```bash
npm run deploy:dockerhub
npm run deploy:ghcr
```

如果 Pages 域名或自定义域名里不包含 `dhub` / `dockerhub` / `ghcr`，在 Cloudflare Pages 项目的变量里设置：

```text
REGISTRY=dockerhub
```

或：

```text
REGISTRY=ghcr
```

可选变量：

```text
CACHE_MODE=public
```

设为 `off` 或 `bypass` 可以关闭边缘缓存。默认缓存公开拉取路径：blob digest 30 天、manifest digest
7 天、tag manifest 5 分钟、tag list 1 分钟。不要把默认缓存模式用于私有镜像。

## Docker Hub 使用

Docker Hub 适合配置为 Docker daemon mirror：

```json
{
  "registry-mirrors": ["https://dhub-23h.pages.dev"]
}
```

然后正常拉取：

```bash
docker pull alpine:latest
docker pull library/nginx:latest
docker pull bitnami/redis:latest
```

也可以直接指定代理域名：

```bash
docker pull dhub-23h.pages.dev/library/alpine:latest
```

单段官方镜像路径会自动补成 `library/<name>`。

## GHCR 使用

Docker 的 `registry-mirrors` 主要用于 Docker Hub。GHCR 建议直接把代理域名当作 registry host：

```bash
docker pull ghcr-6u5.pages.dev/owner/image:tag
```

这个代理主要面向公开镜像。私有镜像请关闭缓存，或单独部署一个只供可信网络使用的项目。
