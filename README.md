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

Android 显示版本使用日期构建号；当前为 **2026100804**。不包含业务数据、账号、生产配置、SDK 安装目录、APK 或旧 Git 历史。

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
