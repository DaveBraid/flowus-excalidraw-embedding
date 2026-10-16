# 部署与维护

先完成 [README 的本机初始化](README.md#quickstart本机运行)，确认一张测试画布能够保存和重新加载。运行配置、凭据与真实内容均由部署者自行提供。

## 直接运行 Node.js

使用 Node.js 24，从项目根目录执行 `node --env-file=.env server/index.mjs`。通过你自己的进程管理器保持单实例运行，并在升级前运行 `npm ci`、`npm test`、`npm run build`。SIGTERM 会等待当前保存及回收结束，建议预留至少 90 秒。

本站使用 scrypt 密码哈希及独立签名会话。HTTPS 会话使用 Secure、HttpOnly、SameSite=None、Partitioned 属性；写请求还检查精确 Origin 与 CSRF token。`PUBLIC_ORIGIN` 必须与浏览器来源完全一致，不带末尾斜线。不要向公网直接暴露绕过反向代理的应用端口。

同宿主机 Caddy 示例位于 [ops/Caddyfile.example](ops/Caddyfile.example)。替换域名，配置 DNS，再按 Caddy 官方流程验证与加载。示例不修改任何既有代理或其他服务。

## Docker Compose

镜像从 npm 锁文件构建前端，运行时只需要 Node.js 标准库和独立 FlowUs CLI。CLI 通过只读文件挂载注入，不打包进镜像。

1. 在目标服务器建立项目目录，配置独立 OAuth、`.env` 及 `secrets/`。可在该服务器安装 Node.js 24，按 QuickStart 先初始化存储，再切换到容器。
2. 下载与**容器 Linux 和 CPU 架构**匹配的官方 CLI，校验官方 SHA-256 后放到 `bin/flowus` 并赋予执行权限。macOS 的 CLI 不能在 Linux 容器运行。官方归档为 `https://cdn2.flowus.cn/flowus-cli/releases/v0.3.13/flowus-linux-x64.tar.gz` 或 `flowus-linux-arm64.tar.gz`；校验文件为同目录的 `SHA256SUMS`。可按官方安装器中的下载及校验逻辑手工取用。
3. Compose 默认 UID/GID 为 `1000:1000`。设置 `.env` 中的 `DRAW_UID` / `DRAW_GID`，并确保容器身份拥有 OAuth 目录及凭据文件，能读写 OAuth 状态、能读取秘密文件。目录权限 0700，凭据权限 0600；无需放宽为所有用户可读。Linux 可使用 `sudo chown -R 1000:1000 oauth-state secrets`。缩略图命名卷初始归属也是 `1000:1000`；使用其他 UID/GID 时，须在停机窗口按 Docker 卷权限管理流程调整该卷所有者后启动。macOS Docker Desktop 的挂载权限另需在实际环境验证。
4. `.env` 中设置真实 HTTPS `PUBLIC_ORIGIN`。Compose 会覆盖 OAuth、CLI、秘密和缩略图的容器内路径；根 ID、工作区 ID 与原生设置页 ID 保持自己的配置。

```bash
docker compose config --quiet
docker compose build
docker compose up -d --wait
curl --fail http://127.0.0.1:3000/healthz
```

Compose 只向宿主机回环地址发布 3000 端口，适合由同机 HTTPS 代理转发。容器文件系统只读，OAuth 目录可写以便官方 CLI 刷新；缩略图使用命名卷。不要执行多副本扩容。

通过实际登录、创建、保存、重新加载验证数据链路。只有存活检查成功仍不足以确认授权、权限与配额。

## 维护与恢复

- `.env`、`secrets/`、`oauth-state/`、`bin/`、`cache/` 均被 Git 忽略。备份时按秘密材料管理。FlowUs 是内容源，服务器缩略图卷可删除重建。
- `DRAW_READ_ONLY=1` 会暂时拒绝业务写请求并暂停回收；修改后重启。恢复写入时设为 `0` 并重启。只读模式仍允许登录及退出。
- `node --env-file=.env ops/audit-state.mjs` 读取画布与图片并输出哈希、数量及设置；结果可能包含你的 slug，应保留在私有环境。
- 需要重设密码时，在维护窗口备份并移走旧 `secrets/password-hash`、`session-secret` 后重新运行秘密生成器。旧会话失效；容器文件挂载发生替换后应重新创建容器。
- 若秘密生成因磁盘或权限错误只创建了一个文件，先备份并移走两个路径中已有的文件，再重新生成；不要在未知的部分状态下覆盖。
- 页面损坏、移动或失权只使对应卡片异常；索引损坏会阻止全局读取。优先在 FlowUs 恢复原文件夹和数据页，再通过列表的“修复索引 / 恢复”接回原链接。
- 画布删除会保留墓碑，结果不明时保持停止写入。不要手动移除墓碑或将未知结果当作删除成功。释放标识是独立操作。

## 数据结构与并发

数据根内的 `general settings` 原生页包含 registry 与 settings 两个 JSON 代码块。registry 记录稳定 folder/page/block IDs、创建意图和画布状态。每个画布文件夹内的原生场景页另有上传任务块。普通保存原位更新场景代码块，不上传新的 JSON 对象。

保存把操作 ID、请求摘要与近期提交凭证随场景一起提交。未知结果先查询再重试；凭证窗口仅保留近期 32 条，查不到时返回未知。每张画布的锁只在当前进程生效。上游没有代码块原子 CAS，外部编辑仍可能在最后校验与写入之间竞争，因此单实例与避免外部写入是运行约束。

回收仅作用于有本应用归属、任务凭证及哈希验证的对象。每轮和删除前重新读取设置与全局引用；读取失败时不删除。任何仍在其他窗口中但尚未提交的编辑都不属于服务器的已提交引用。宽限期内应保存，或先导出本地画布。

## 旧附件格式迁移

新部署只使用 `ops/init-native.mjs`。`ops/migrate-native.mjs` 保留供本项目旧附件格式升级及离线测试使用，它要求既有旧设置附件与至少一张旧画布，不能初始化空根。

迁移前必须停用旧写入器、确认维护模式实际拒绝写入、备份数据，再设置 `DRAW_MIGRATION_WRITE_GATE=confirmed` 运行迁移。该脚本会创建原生页并标记旧附件为迁移备份；只有完整核对后 registry 才标记 ready。不得把它用于未知结构或通过配置回退到旧附件写入器。迁移、恢复与真实上游容量均需在部署者自己的测试目录验证。
