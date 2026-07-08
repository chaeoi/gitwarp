# GitWarp

把部署域名加到镜像名前面即可。下面以 `gitwarp.pages.dev` 为例。

## 使用

Docker Hub 镜像：

```bash
docker pull gitwarp.pages.dev/alpine:latest
docker pull gitwarp.pages.dev/library/nginx:latest
docker pull gitwarp.pages.dev/bitnami/redis:latest
```

原来带 registry host 的镜像，保留原 host：

```bash
docker pull gitwarp.pages.dev/ghcr.io/owner/image:tag
docker pull gitwarp.pages.dev/quay.io/prometheus/prometheus:latest
docker pull gitwarp.pages.dev/registry.k8s.io/pause:3.9
docker pull gitwarp.pages.dev/mcr.microsoft.com/dotnet/runtime:8.0
docker pull gitwarp.pages.dev/public.ecr.aws/nginx/nginx:latest
docker pull gitwarp.pages.dev/registry.gitlab.com/group/project/image:tag
docker pull gitwarp.pages.dev/gcr.io/distroless/static:latest
docker pull gitwarp.pages.dev/us-docker.pkg.dev/project/repo/image:tag
```

也可以把它设成 Docker Hub mirror：

```json
{
  "registry-mirrors": ["https://gitwarp.pages.dev"]
}
```

只做拉取代理，不支持 push、delete、upload。带认证的请求不会被缓存。

## 自定义域名

绑定自定义域名后，前端示例会根据浏览器当前 `location.origin` 自动替换为新域名；Docker Registry 认证挑战里的 `realm` 和 `service` 也会使用当前请求域名。因此 `https://mirror.example.com/alpine:latest`、`https://mirror.example.com/ghcr.io/owner/image:tag` 这类路径可以直接工作。

如果用作 Docker Hub mirror，把自定义域名写进 Docker 配置即可：

```json
{
  "registry-mirrors": ["https://mirror.example.com"]
}
```

## 项目结构

参考 `github.com/chaeoi/speedtest` 的 Pages 项目布局，静态网站直接放在根目录，函数逻辑按职责拆到 `functions/_lib`：

```text
.
├── index.html
├── assets/
│   ├── css/main.css
│   ├── js/main.js
│   └── icon.svg
├── functions/
│   ├── [[path]].js
│   └── _lib/
│       ├── auth.js
│       ├── cache.js
│       ├── constants.js
│       ├── dockerhub.js
│       ├── handler.js
│       ├── http.js
│       ├── path.js
│       ├── public-url.js
│       ├── registries.js
│       ├── responses.js
│       ├── routes.js
│       └── upstream.js
└── package.json
```

本地开发：

```bash
npm run dev
```

测试：

```bash
npm test
```

部署：

```bash
npm run deploy
```
