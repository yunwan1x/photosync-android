# 来源与许可证

本仓库从本地 Photos 客户端源码提取 Android 构建所需部分，不包含服务端或 Web。

- 上游：https://github.com/immich-app/immich
- 基线版本：v3.0.3
- 基线提交：cd308ad93093735135f99d85ce6980c8e93df231
- Android home_widget 修复来源：507448d797d928ac3675c0e3a380f304925fcdea
- 原项目说明见上游仓库；原有版权声明和 AGPL-3.0 许可证保留。
- 除 Flutter/Dart 源码外，mobile/openapi 是已生成的本地 SDK，mobile/packages/ui 是本地 UI 依赖，i18n 是翻译输入，均为构建所需。
- 当前提取版本：pubspec 3.0.3+2026100804，Android versionName 2026100804；基础构建号 2026100804，arm64 分包 versionCode 为 2026102804。
