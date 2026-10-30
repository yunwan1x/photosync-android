# Android 构建验证

> 本文记录早先的本地构建与联调；当前云端发布产物、签名和校验值以 `CI_RELEASE.md` 及 GitHub Release 为准。

- 日期：2026-10-30。
- 源码提交：`d9db87f71a5690bf47e388e963f23cf005b1e042`。
- 从本仓库独立目录执行 `./scripts/build-android.sh`，翻译、Pigeon、build_runner 与 Gradle assembleRelease 全部通过。
- Flutter 3.44.1，Java 21.0.2；Gradle 堆内存 4 GiB（项目默认值）。
- Android release APK，仅包含 `arm64-v8a`。
- 包名：`app.alextran.immich`。
- versionName：`2026100804`；versionCode：`2026102804`（Flutter arm64 分包在基础构建号上加 2000，与原 APK 一致）。
- 文件名：`photosync-android-arm64-v8a-latest.apk`。
- 文件大小：68515020 字节。
- SHA-256：`252b60d155341abff16bfe67e17eaeb0e624a991a7bc9e20bed9ce83fe4d1db2`。
- APK 签名验证通过；本次使用开发签名，不包含原正式签名密钥，不是正式发布。
- Signer #1 certificate SHA-256 digest: 12e069c19d16106abd1144ecff8e15ab40289a7b5c36af7fc8d4f38bfdefa4c6

仅验证源码可构建 APK；未在本次操作中重新执行设备后台备份测试或发布 APK。APK、SDK、依赖缓存与私有凭据不提交到 GitHub。
