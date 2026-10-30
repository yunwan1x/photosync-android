# 服务端与 Android 联调验证（2026-10-30）

> 本文记录早先的本地构建与联调；当前云端发布产物、签名和校验值以 `CI_RELEASE.md` 及 GitHub Release 为准。

本次基于新仓库中的源码重新编译和测试。原 Photos 目录及生产 Immich 数据未修改；NAS 生产 Immich 和 TaleBook 持续运行。

## 范围与结果

| 项目 | 结果 |
| --- | --- |
| 服务端 NestJS / TypeScript 编译 | 通过 |
| 服务端 TypeScript 静态检查 | 通过 |
| 共享 TypeScript SDK / plugin-sdk 编译 | 通过 |
| 核心插件 TypeScript + WASM 编译及服务端加载 | 通过 |
| Web 生产构建 | 通过 |
| 服务端单元测试 | 100 个测试文件；2303 通过，2 跳过 |
| Web 单元测试 | 53 个文件通过、1 个文件跳过；514 通过，2 跳过 |
| Flutter 完整测试 | 1148 通过，1 跳过，0 失败 |
| Android 原生单元测试 | 34 通过，0 跳过、0 失败 |
| Android arm64 release APK | 重新编译、签名验证及模拟器安装通过 |
| 独立 SQLite / 内存缓存服务运行 | 通过，独立端口 2295 |
| 实际 HTTP API 联调 | 15 项通过 |
| APK 登录、远端相册展示、本地相册识别 | 通过 |
| APK 两张本地照片备份 | 上传到独立服务端通过 |
| APK 后台、息屏、大视频、断网恢复 | 310924809 字节，完成且服务端原文件 SHA-1 一致 |

## 修正的问题

原锁文件将 drift 2.34.4 与 drift_dev 2.34.0 混用。完整测试中的数据库迁移验证器无法编译（drift3 preview API 不一致）。

将两者都固定为 2.34.0，保留现有 pigeon 26.3.4 / analyzer 12 的兼容组合，更新 pubspec.lock，重新生成代码并编译 APK。生成代码内容未产生 Git 差异，完整 Flutter 测试通过。

## 实际 API 验证

可复用脚本：`scripts/test-standalone-api.py`。必须仅针对空的隔离测试服务运行；参数明确要求 `--isolated-test-server`。测试账号随机生成，凭据写到仓库以外的指定权限 0600 文件。

通过：ping、管理员初始化与登录、用户信息、multipart 照片上传、同账号照片重复识别、原照片下载 SHA-1、相册创建与列表、未完成上传不能完成、错误偏移返回 409、重新连接读取已保存偏移、310924793 字节视频分块上传与完成、视频下载 SHA-1、视频重复识别、完成后会话清理、错误 SHA-1 返回 422。

## APK 与服务端实测

使用新编译 APK，Android 14 redroid、ARM64 转译层，与本次源码编译出的服务端及 Web 联调。登录后能显示 API 上传的照片与视频；选择本地 SourceValidation 相册并启用备份，两张本地照片成功上传。

随后按 Home 使应用退到后台并关闭屏幕，扫描一个 310924809 字节视频。服务端断点会话达到 8388608 字节时关闭 Android eth0，6 秒后恢复。断网期间持久化偏移为 16777216 字节（包含已在途的分块），恢复后自动完成，服务端保存的原视频 SHA-1 与源视频相同。完成时 `mWakefulness=Asleep`。此测试由 Android 自身任务调度执行，没有强制运行 JobScheduler 任务。

模拟器中授予媒体、通知权限，允许非 Wi-Fi 备份并加入电池优化白名单。默认 Android 联网验证无法访问探测地址，导致 WorkManager 正确等待 VALIDATED 网络；仅在隔离模拟器里关闭 captive portal 探测并重新连接网卡后网络变为 VALIDATED。另关闭模拟器 MediaProvider 的 next-row-id xattr 备份，解决容器媒体库初始化错误。这些均是测试环境设置，未修改应用或 Windows / NAS 的网络策略。

Android 16 容器虽能启动，但其 ARM64 转译层无法加载 libc 的 `__clone_for_fork`，应用无法启动，因此实际 APK 联调用 Android 14 完成。

## 编译环境与产物

- Linux x86_64 NAS；Node 24.14.1（已有构建基础镜像；仓库声明为 24.15.0），pnpm 11.6.0。
- Flutter 3.44.1、Java 21.0.2；保持 Gradle 4 GiB 堆内存。
- package：`app.alextran.immich`；versionName：`2026100804`；versionCode：`2026102804`；仅 `arm64-v8a`。
- APK：`artifacts/releases/photosync-android-arm64-v8a-latest.apk`，68515020 字节。
- SHA-256：`90397d015265e455b92500a18aa2f9a482ece5db628294fab7ffb0f1d23c0dd1`。
- 使用开发签名，apksigner verify 通过。APK 不提交到 Git、不上传发布服务器。
- 服务端运行本次 `nest build` 产物、同次安装的锁定依赖和新编译的核心插件；Web 使用本次构建产物。地理位置数据子集复用现有运行镜像中的公开资源，未重新下载 Geonames 全量数据。

## 验证边界

以上证明列出的构建、测试和核心备份场景通过，不表示所有 Immich 功能或所有手机均无问题。

本次未运行 PostgreSQL medium/e2e 全套测试、机器学习推理/人脸识别、真实手机厂商后台策略、真实 Wi-Fi/蜂窝切换、端到端真实 DNS TXT 记录变化、付费/外部登录/推送/分享的所有组合。TXT 动态地址解析及上传相关回归由本次 Flutter 测试覆盖。

未重新构建或推送完整生产 Docker 镜像，未替换线上服务，未发布 APK。GitHub 上传的是源码与此验证记录，仓库保持私有。

## 本地证据

详细日志和 JSON 验证结果位于 NAS `/vol1/1000/wy/photos-apk-test/fullstack-validation`。账号、媒体数据、缓存、构建产物和日志未提交到 Git。
