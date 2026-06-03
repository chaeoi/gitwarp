# GitWarp

一个用 Cloudflare Pages Functions 部署的 Docker/OCI Registry v2 拉取代理。GitWarp 使用单个
hostname，对 Docker Hub 走根路径，对其他 registry 走路径前缀。

项目只允许 `GET`、`HEAD`、`OPTIONS`，用于拉取镜像；`POST`、`PUT`、`PATCH`、`DELETE`
会被拒绝。默认只缓存未携带 `Authorization` 的公开拉取响应。

## 本地开发

先全局安装 Wrangler：

```bash
npm install -g wrangler@4.95.0
```

然后启动本地代理：

```bash
npm run dev
```

## 部署

```bash
npm run deploy
```

部署脚本使用 Cloudflare Pages 项目名 `gitwarp`。建议给这个 Pages 项目绑定一个统一域名，例如：

```text
registry.example.com
```

可选变量：

```text
DEFAULT_REGISTRY=dockerhub
CACHE_MODE=public
UPSTREAM_TIMEOUT_MS=30000
```

`DEFAULT_REGISTRY` 默认是 `dockerhub`。`CACHE_MODE` 设为 `off` 或 `bypass` 可以关闭边缘缓存。
默认缓存公开拉取路径：blob digest 30 天、manifest digest 7 天、tag manifest 5 分钟、tag list
1 分钟。带 `Authorization` 的请求不会写入边缘缓存。

## Docker Hub

Docker Hub 默认使用根路径，因此适合配置为 Docker daemon mirror：

```json
{
  "registry-mirrors": ["https://registry.example.com"]
}
```

然后正常拉取：

```bash
docker pull alpine:latest
docker pull library/nginx:latest
docker pull bitnami/redis:latest
```

也可以直接指定 GitWarp 域名：

```bash
docker pull registry.example.com/alpine:latest
docker pull registry.example.com/library/nginx:latest
```

单段官方镜像路径会自动补成 `library/<name>`。

如果 Docker Hub 仓库名和某个 registry 前缀冲突，可以显式使用 `dockerhub` 前缀：

```bash
docker pull registry.example.com/dockerhub/library/alpine:latest
```

## 其他 Registry

其他 registry 使用统一域名下的第一段路径前缀。代理会在转发到上游时移除这个前缀。

| 前缀 | 上游 registry | 示例 |
| --- | --- | --- |
| `ghcr` | `ghcr.io` | `docker pull registry.example.com/ghcr/owner/image:tag` |
| `quay` | `quay.io` | `docker pull registry.example.com/quay/prometheus/prometheus:latest` |
| `gcr` | `gcr.io` | `docker pull registry.example.com/gcr/distroless/static:latest` |
| `k8s` | `registry.k8s.io` | `docker pull registry.example.com/k8s/pause:3.9` |
| `mcr` | `mcr.microsoft.com` | `docker pull registry.example.com/mcr/dotnet/runtime:8.0` |
| `ecr` | `public.ecr.aws` | `docker pull registry.example.com/ecr/nginx/nginx:latest` |
| `gitlab` | `registry.gitlab.com` | `docker pull registry.example.com/gitlab/group/project/image:tag` |
| `nvcr` | `nvcr.io` | `docker pull registry.example.com/nvcr/nvidia/image:tag` |
| `lscr` | `lscr.io` | `docker pull registry.example.com/lscr/linuxserver/nginx:latest` |
| `redhat` | `registry.access.redhat.com` | `docker pull registry.example.com/redhat/ubi9/ubi:latest` |
| `gar/<host>` | `*-docker.pkg.dev` | `docker pull registry.example.com/gar/us-docker.pkg.dev/project/repo/image:tag` |

例如：

```bash
docker pull registry.example.com/ghcr/homebrew/core/git:latest
docker pull registry.example.com/quay/prometheus/prometheus:latest
docker pull registry.example.com/k8s/pause:3.9
docker pull registry.example.com/mcr/dotnet/runtime:8.0
```

这个代理主要面向公开镜像拉取。私有镜像即使携带凭据也不会被缓存；不要把它作为推送、删除、
上传或通用写入代理使用。
