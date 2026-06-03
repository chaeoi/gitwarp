# GitWarp

把 `gitwarp.pages.dev/` 加到镜像名前面即可。

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
