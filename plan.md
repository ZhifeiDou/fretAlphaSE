我上一条确实没有把核心交付讲清楚。**MCP 入口、构建和 Docker 是这次接入的主体工作，应该明确到接口、文件职责、运行方式和验收标准。**

下面按上一条提出的“形式化＋可实现性分析”范围展开。**这是具体建议，首批能力和接口名称还没有被你确认。**

**MCP 服务怎么供 AlphaSE 调用**

建议在这里增加一个独立 Node 服务，通过 **Streamable HTTP 的 `/mcp` 端点**提供计算能力。这与 AlphaSE 当前 Artifact MCP 的传输方式一致；协议交互、工具发现和参数校验使用官方 SDK。[现有入口](/C:/Cawl/mcps/artifact/artifact_mcp/server.py)、[官方 SDK 说明](https://ts.sdk.modelcontextprotocol.io/server)

最小接口可以是：

| 拟议工具 | 输入 | 输出与行为 |
|---|---|---|
| `formalize_requirements` | 需求 ID、FRETish、目标公式表示 | 逐条返回公式、语义解释、编译错误或不支持原因 |
| `start_realizability_check` | 固定需求集合、变量类型与 I/O、假设身份、时间模型、分析选项 | 保存输入快照并启动分析，立即返回 `job_id`、输入摘要和状态 |
| `get_analysis` | `job_id` | 返回当前阶段；完成后返回结论、实际分析范围、版本信息及可获得的反例 |
| `cancel_analysis` | `job_id` | 停止该任务及其求解器子进程，完成终止后更新状态 |

长任务通过这些显式接口管理，不预设 AlphaSE 已支持某个版本的 MCP Tasks 扩展。

**鉴权也属于入口工作。** AlphaSE 当前会验证 Forgejo Bearer 身份，并按角色限制工具。新服务需要对齐这套规则，检查工具权限及任务结果的读取、取消权限，不能只配置一个 URL。[现有身份与权限实现](/C:/Cawl/mcps/vc/vc_mcp/application.py)

**具体新增哪些文件**

我建议把服务集中放在一个 `mcp/` 目录，文件按实际职责拆分：

```text
mcp/
├── package.json               服务依赖，以及 build/start/test 命令
├── package-lock.json          固定依赖版本
├── webpack.config.cjs         构建 Node 服务和计算 worker
├── src/
│   ├── server.js              HTTP/MCP 入口、工具注册、服务关闭
│   ├── schemas.js             工具输入、结果与任务状态的数据定义
│   ├── auth.js                对接调用者身份与权限
│   ├── jobs.js                任务状态、工作目录、取消、结果保存
│   └── worker.js              接收输入快照，调用 FRET 核心与后端
├── tests/
│   ├── mcp.test.js            用真实 MCP 客户端验证接口
│   ├── analysis.test.js       用真实求解器验证分析结果
│   └── lifecycle.test.js      验证隔离、取消、超时与清理
├── Dockerfile                构建和运行服务镜像
├── Dockerfile.dockerignore    限定构建上下文
└── README.md                 接口、配置及运行说明
```

这里的 `worker.js` 有明确用途：**让计算状态属于当前任务，并让超时、取消能够终止整次计算。** 服务进程负责接收请求和管理结果，worker 执行现有 FRET 算法。工作目录仍需显式隔离，不能仅靠开一个子进程。

之前列出的 `realizabilityUtils.js` 等核心改动，是为了让这个 worker 能接收固定数据，而不是继续从桌面项目数据库取当前内容。

**服务构建具体要做什么**

现有 [package.json](/C:/fretAlphaSE/fret-electron/package.json) 的安装脚本会触发 Electron 相关工作；计算模板还使用了 `ejs-compiled-loader`。[模板入口](/C:/fretAlphaSE/fret-electron/support/RealizabilityTemplates/ejsCache_realize.js:6)

因此需要：

- 建立服务自己的依赖清单和锁文件。
- 为 Node 构建配置 Babel/Flow 转换、EJS 模板和语义 JSON 的打包规则。
- 显式配置服务依赖的解析路径，确保能从同仓库的 FRET 源码构建。
- 产出可独立运行的服务、worker 及必要运行资源。
- 验证产物脱离开发目录后仍能编译需求、生成合同并启动后端。

**Docker 配置具体交付什么**

建议采用多阶段构建：构建阶段安装编译依赖、生成产物；运行阶段只携带服务运行依赖、FRET 计算资源和选定求解器。[Docker 多阶段构建说明](https://docs.docker.com/build/building/multi-stage/)

运行合同需要明确：

| 项目 | 拟议行为 |
|---|---|
| 启动 | 容器启动后直接运行 MCP 服务 |
| 后端版本 | 固定并验证 FRET、Node、分析后端和求解器的组合 |
| 健康检查 | 检查服务及所声明能力所需的后端是否就绪 |
| 临时文件 | 每个任务独立目录，结束后按任务回收 |
| 分析结果 | 输入快照、状态和报告保存到独立结果卷，临时文件清理不影响读取 |
| 容器停止 | 停止接收新任务，终止正在运行的计算并记录中断状态 |
| 容器重启 | 建议将遗留未完成任务标为 `interrupted`，首版不自动续算 |

AlphaSE 一侧还需要加入 Compose 服务、地址配置、生命周期管理和角色工具权限；这些是另一个仓库的接线工作，不能把“这里镜像能启动”当成双方已经接通。

**验证用例必须证明哪些事情**

- **协议确实接通**：通过 MCP 客户端完成初始化、发现工具、调用和解析结构化结果。
- **计算确实有效**：用真实后端检查已知可实现和相互矛盾的合同，确认结论与范围。
- **没有静默漏项**：提交中包含不能参与分析的需求时，必须明确报告。
- **任务互不污染**：两个任务使用不同输入和文件，结果分别匹配各自输入摘要。
- **取消、超时真正生效**：相关进程停止，状态准确，其他任务继续运行。
- **结果生命周期正确**：清理临时目录或重启容器后，已保存报告仍可取回。

这些是目前展开后的拟议交付内容；尚未创建上述服务文件，也没有构建或启动镜像。