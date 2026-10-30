# PhotoSync — Android 与服务端

从 Photos（Immich fork）提取的 Android 客户端及完整服务端源码，包含 Web、机器学习、API SDK、Docker 定义和自动化测试。仓库名称保留 photosync-android；不包含生产数据、密钥、iOS 工程或旧测试环境。

## 构建环境

- Linux x86_64，建议 8 GiB 内存和至少 15 GiB 空间。release 压缩保持项目默认 4 GiB Gradle 堆内存，2 GiB 不足以完成 R8 压缩。
- [mise](https://mise.jdx.dev/)、Python 3、Git、Android SDK command-line tools。
- Flutter **3.44.1**、Java **21.0.2**（mise 配置已固定）。
- Android platform **36**；接受 Android SDK 许可证，安装 Flutter 所需的 NDK/CMake。Gradle/AGP/Kotlin 版本由 Android 工程固定。

```bash
mise trust
cd mobile && mise trust && mise install && cd ..
export ANDROID_HOME=/absolute/path/to/Android/Sdk
./scripts/build-android.sh
```

脚本依次安装 Dart 依赖、生成翻译/Pigeon/build_runner 代码，再执行：

```bash
cd mobile
mise exec -- flutter build apk --release --target-platform android-arm64 --split-per-abi
```

输出：`artifacts/releases/photosync-android-arm64-v8a-latest.apk`。构建需要访问 pub、GitHub、Google/Maven/Gradle 仓库；代理通过系统环境配置，不在源码中保存代理凭据。

## 签名

本仓库不包含原应用签名密钥或任何口令。没有私有 keystore 时，现有 Gradle 配置使用开发签名生成 release APK，方便独立编译验证；这类包不能覆盖安装原来私有签名的应用。正式更新必须由原签名持有者在本机安全提供 `mobile/android/key.jks`，通过未跟踪的 `key.properties` 或环境变量 `ALIAS`、`ANDROID_KEY_PASSWORD`、`ANDROID_STORE_PASSWORD` 设置签名。不要把这些文件和变量值提交到 Git。

## 目录

- `mobile/`：Flutter、Android 原生代码、OpenAPI 本地 SDK、UI 包与客户端测试。
- `i18n/`：翻译生成输入。
- `scripts/`：独立 Android 构建脚本与翻译校验。
- `UPSTREAM.md`、`LICENSE`：来源和 AGPL-3.0 许可证。

Android 显示版本使用日期构建号；当前为 **2026103001**。不包含业务数据、账号、生产配置、SDK 安装目录、APK 或旧 Git 历史。

## 服务端

- `server/`：Immich API、后台任务、PostgreSQL / SQLite、上传与断点续传。
- `web/`：配套 Web 客户端；`packages/`：共享 SDK、CLI、插件。
- `machine-learning/`：可选机器学习服务。
- `docker/`：容器定义；`e2e/`：集成测试；`open-api/`：API 规范。
- Node 24.15.0、pnpm 11.6.0，版本见根目录 mise.toml。

```bash
pnpm --filter @immich/sdk --filter @immich/plugin-sdk --filter immich --filter immich-web install --frozen-lockfile
pnpm --filter @immich/sdk --filter @immich/plugin-sdk build
pnpm --filter immich build
pnpm --filter immich test --run
pnpm --filter immich-web build
docker build --file server/Dockerfile --tag changhui/photosync:latest .
```

服务端 Docker 构建上下文必须是仓库根目录。测试不得绑定生产数据目录。上游端到端媒体数据集为独立仓库 https://github.com/immich-app/test-assets，不包含在当前导出中，运行相关测试前需按上游版本准备。测试结论记录在 FULLSTACK_VALIDATION.md。

## GitHub Actions 与 Release

在 Actions → Build and release PhotoSync → Run workflow 填写 tag（例如 `v2026.10.30.1`）和递增的 Android 日期 build number（例如 `2026103001`）。也可推送同格式版本标签触发。普通分支提交不自动构建。

三个组件分别构建：Android arm64 release APK、linux/amd64 服务端镜像 `changhui/photosync:latest`、CPU ML 镜像 `changhui/photosync-machine-learning:latest`。ML 包含并验证默认模型。全部任务成功后才发布 GitHub Release；失败保留草稿。Release 附 APK、SHA256SUMS、两个镜像摘要 JSON；无需把大型镜像重复存为 Actions artifact。

所需仓库 Secrets：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`、`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`、`ANDROID_STORE_PASSWORD`。签名必须延续现有密钥，不允许缺少密钥时自动使用临时签名。APK 当前沿用已有开发签名。不要在日志输出 Secrets。

流程只构建、测试、推送镜像和创建 Release，不连接或替换 NAS / 服务器上的服务。使用标准 Ubuntu runner，只缓存公开工具链和依赖，不缓存签名、业务数据或 Docker tar 包；私有仓库仍消耗账号的 Actions 免费分钟额度，超额计费取决于账号预算。

APK 重试可选 `component=android`：只针对已有草稿的固定源码提交重建 APK，校验并复用该草稿中已经构建通过的两个镜像摘要；全部测试通过后才发布。编译阶段限制 Gradle / Kotlin 内存与进程并行，编译结束前先上传到草稿并保存依赖缓存，运行测试前释放 Gradle 进程，防止重复 JVM 累积内存。缓存保持默认 10 GiB 上限，不启用额外付费缓存容量。

如果 APK 已成功上传草稿而仅测试失败，可选 `component=android-tests`：从草稿下载 APK 并校验原签名、版本、架构与 SHA256，针对草稿固定源码重新生成测试输入、运行原生 Release 和 Flutter 测试，不重复编译 APK 或镜像。原生测试在 Flutter 测试之前执行，防止 dev-only 插件注册混入 Release。三个模式均禁止覆盖已发布版本。
