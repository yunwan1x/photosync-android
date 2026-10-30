# 首次 GitHub Actions 发布验证

- 日期：2026-10-30。
- Release：https://github.com/yunwan1x/photosync-android/releases/tag/v2026.10.30.1
- 产品源码：`61bd2e2052367cc3d8b93a62d7308ef7fbf09c9b`。
- 发布流程修复提交：`6245023`。修复仅影响 CI；草稿重试固定产品源码，不混合不同版本。
- 完成发布的 Actions：https://github.com/yunwan1x/photosync-android/actions/runs/41067408750
- 完整组件构建：https://github.com/yunwan1x/photosync-android/actions/runs/41055535569

## APK

- 文件：`photosync-android-arm64-v8a-latest.apk`；68,515,020 字节；仅 arm64-v8a。
- 包名：`app.alextran.immich`；versionName `2026103001`；versionCode `2026105001`。
- SHA256：`66ca423ad22bc916d6614ead95916dc4c220178e705a47bd84ec6bf438577d48`。
- 沿用原 APK 签名；证书 SHA256：`a2397706509fc8a74c08489b9735f0a1fa9aa0a09fb2a49a72345f29a8b18b39`。
- 云端 Release 编译、签名/版本/架构验证通过；Flutter 1,148 项通过、1 项跳过；Android 原生 Release 单元测试通过。
- 发布后重新下载附件，独立检查大小、SHA256、签名、包名、版本及架构，全部通过。

## 服务端与 ML

- 服务端生产镜像完成后端/网页/插件编译、TypeScript 检查、2,300 项单元测试（2 项跳过）及 SQLite 启动/ping 检查。
- CPU ML 镜像完成 Python 编译检查、随包默认模型的校验与加载、启动/ping 检查。
- 以上镜像均在云端推送，并在发布后从 Docker Hub 再次核对摘要。
- 镜像平台均为 `linux/amd64`；标签统一使用 `latest`。
- `changhui/photosync-machine-learning:latest` 当前需要有权限的 Docker Hub 登录；部署端先执行 `docker login -u changhui`，交互输入凭据。

- `changhui/photosync:latest`：`changhui/photosync@sha256:cdf188577be9eeb6290cf4c556239e35ba08ca05154823b5e0c3454a759c2fcf`。
- `changhui/photosync-machine-learning:latest`：`changhui/photosync-machine-learning@sha256:867a932d83e5a31e9a756b20f36bfa0616c9c80b97f7ab3fccdfb12fcb3f36fd`。

## 流程与范围

Actions 支持手动运行及版本标签触发；普通分支提交不触发构建。所有验证成功才发布，失败留草稿。重试模式复用同一草稿源码和已验证产物；不覆盖已发布版本。具体输入和 Secrets 名称见 README。

本次构建并发布 APK 与两个镜像，没有替换 NAS 或公网服务器上的运行服务。历史本地设备/备份联调见 FULLSTACK_VALIDATION.md；本次云端未重新进行真实手机后台、Wi-Fi/蜂窝切换及全部 Immich 功能验证。

## 公开仓库与构建性能优化（2026-10-30）

仓库已改为公开，变更前扫描全部提交历史与已知实际凭据，未发现实际账号口令、GitHub token 或 APK 签名文件；扫描命中项均核对为上游测试样例及依赖版本字符串。APK 签名与镜像推送所需的 6 个 Secrets 继续由 GitHub 加密保存。

实际 runner 资源：4 CPU、约 16GB RAM。固定 Ubuntu 24.04，保留已安装且仍需的 SDK 组件；使用 4 个 Gradle worker、6 GiB JVM 堆，并将 APK 与测试分配到独立 runner 并行。编译缓存保存 Gradle build-cache 与 transforms；不会缓存私有签名或业务数据。

| 阶段 | 优化前 | 优化后 |
| --- | --- | --- |
| Gradle Release APK | 1446.9 秒（24 分 7 秒） | 686.1 秒（11 分 26 秒） |
| 生成代码及完整 APK 构建步骤 | 未单列 | 770 秒（12 分 50 秒） |
| Android 原生 Release 测试 Gradle | 8 分 38 秒 | 6 分 14 秒 |
| Flutter 测试 | 2 分 14 秒 | 1 分 19 秒，1148 通过、1 跳过 |

APK 编译验证：https://github.com/yunwan1x/photosync-android/actions/runs/41073818636/job/124124637797 。该 APK job 成功并通过原签名、版本、架构校验，版本输入为 2026103002；首次编译缓存未命中。该轮独立测试 job 因优化时添加的 `--no-pub` 跳过 Release 插件注册而失败，已在 `4614161` 移除此参数并增加编译前检查。

修复后的完整验证：https://github.com/yunwan1x/photosync-android/actions/runs/41075720950 。该轮复用已发布 APK 进行产物校验，重新运行当前源码的 Android 原生与 Flutter 测试，全部成功；没有重新编译 APK。业务代码未变，以上完整 APK 构建与测试分别由所列成功 job 验证。

本轮启用 `verify_only`，未创建新 Release 或推送新镜像，线上服务不变。编译缓存已成功保存，删除过时的重复 APK 缓存后总缓存约 6.79 GiB，保持默认容量限制；未启用付费 runner 或额外付费缓存。后续命中编译缓存的提速幅度尚未进行完整 APK 重编译实测，不承诺每次固定缩短 53%；云端硬件和网络亦会影响耗时。
