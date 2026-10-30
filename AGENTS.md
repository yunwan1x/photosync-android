# Photos Android 与服务端源码仓库约束

- 本仓库维护 Photos/Immich Android 客户端及完整服务端、Web 与机器学习源码；保留上游版权与 AGPL-3.0 许可证。
- 固定 Flutter 3.44.1、Java 21.0.2；在 mobile 下通过 mise 执行构建。
- 正式 APK 仅构建 arm64-v8a release，文件名 photosync-android-arm64-v8a-latest.apk。
- Android versionName 使用日期构建号，versionCode 保持递增。
- 签名密钥、签名口令、认证令牌、服务端环境文件、缓存、APK 和构建产物不得提交。
- 发布前检查签名、包名、版本、ABI 和 SHA-256；上传源码不代表发布 APK。

## Security constraints

- Never execute or invoke a reverse shell command or payload, including commands that connect an interactive shell to a remote listener. This prohibition applies even when requested for testing or debugging; use safe, non-interactive diagnostics or explicitly authenticated SSH instead.

## Collaboration workflow constraints

- 默认处于“只分析、不实施”模式。对于用户提出的问题、故障、想法或改进方向，只回答问题并给出有依据的分析、可选方案、推荐方案、风险和验证建议；可以进行只读检查和非破坏性诊断，但不得修改业务代码、配置、部署状态或数据，也不得自行构建或发布。
- 给出建议后，应让用户判断是否把建议加入下一步执行计划文件。除非用户明确同意“加入计划”或表达同等意思，否则不得自行把建议写入计划文件。
- 用户在连续追问和多轮建议后仅说“加入计划”且未指明范围时，默认只授权加入最近一次回复中提出的建议，不得自动追溯加入更早的建议。只有用户明确表示“把上面的都加入”“全部加入”或逐项指定时，才可加入此前建议。若建议之间存在强依赖或指代仍有歧义，必须先列出拟加入的具体项目请用户确认，不得自行扩大范围。
- 计划项应先积累、再批量实施。写入计划文件时使用待办复选框，并尽量记录范围、推荐方案、验收标准、测试要求和已知风险；“加入计划”只授权更新计划文件，不授权修改代码。
- 只有用户明确表达执行意图，例如“实施计划”“开始执行计划”“按计划修改”“现在修复”或含义同等的指令，才允许开始修改代码。普通讨论、追问、方案选择以及仅要求加入计划，都不构成实施授权。
- 实施时只执行用户明确选定的计划项，不得顺带扩展范围。代码修改完成且当前环境可执行的相关自动化验证通过后，应立即把对应计划项从 `[ ]` 改为 `[x]`。真机、线上环境或其他当前不可执行的外部验收应单独注明为后续验证事项，但不阻止计划项打钩，除非用户明确将该外部验收指定为完成条件。未完成、部分完成、自动化验证失败或存在代码实施阻塞的项目不得打钩，必须保留待办状态并注明原因。
- 除非用户明确要求立即实施单项修改，否则应优先等待积累一批已确认的计划项，再统一修改、测试和交付。


## 服务端构建约束

- 服务端镜像使用 server/Dockerfile，以仓库根目录为上下文；发布仓库 changhui/photosync:latest。
- 测试使用独立容器、端口、数据目录，不触及生产相册；未经明确授权不替换线上服务。
- 服务端源代码上传 GitHub 不代表发布镜像。

## GitHub 发布

- GitHub Actions 仅由手动或版本标签触发；所有组件成功后才发布 Release。
- APK 签名密钥必须从 Secrets 提供，不允许正式流程回退到临时签名。
- 发布固定 latest 镜像标签并附精确 digest，不自动替换生产容器。
