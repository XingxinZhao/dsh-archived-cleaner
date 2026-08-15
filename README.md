# dsh-archived-cleaner

> DSH（DeepSeek Harness）插件：一键把**已归档的会话记录移入 Windows 回收站**。
> 执行前可勾选清理范围，运行中的会话自动跳过，不影响正在进行的对话。

DSH 的会话持久化是 append-only 事件日志（`~/.dsh/sessions/<项目>/<会话ID>/`），官方**没有删除/保留 API**，官方文档明确："pruning stored sessions is out-of-band backend maintenance"——归档只是把会话从列表里隐藏，日志文件会永久累积占用磁盘。本插件就是这条"外部维护"路径的标准实现：**把会话日志目录移入回收站（可恢复）**，同时自动跳过仍在运行（live）的会话，绝不干扰进行中的对话。

## 功能

- **一键清理**：设置面板 →「清理归档」，列出全部已归档会话（标题 / 日志目录 / 占用大小）
- **勾选执行**：默认全选，可逐项取消；顶部「全选」开关
- **可选：同时清理关联图片**：勾选后，解析被清理会话日志中引用的附件（`~/.dsh/attachments/v1/objects/`），
  对**全部剩余会话**做引用计数，只把「仅被这些会话引用、不再被任何会话使用」的附件移入回收站；
  仍被其他会话使用的图片自动跳过，绝不误删共享附件
- **安全**：
  - 运行中的会话置灰显示「运行中 · 跳过」（包括当前会话与后台子代理）
  - 移入 **Windows 回收站**（`Microsoft.VisualBasic.FileIO`），不是永久删除，误删可恢复
  - Host 端二次复核（live 检查 + 目录存在性校验）后才执行
- **自动同步**：SQLite 搜索索引会在下一次查询时自动剔除已清理的会话
- **主题自适应**：使用 DSH 官方主题 token，浅色 / 深色主题自动跟随；字号跟随系统

## 工作原理

```
浏览器端（lib/client.js）                     Host 端（lib/index.js）
┌──────────────────────────┐   POST /arc-cln   ┌──────────────────────────────┐
│ 设置 → "清理归档" 分区      │ ────────────────▶ │ connection.rpc.handle('/arc-cln') │
│ settings.section 槽位     │ ◀──────────────── │  - candidates: 枚举归档会话+大小 │
│ connection.rpc.call(...)  │   { ok, value }   │  - clean: 复核后移入回收站        │
└──────────────────────────┘                    └──────────────────────────────┘
```

- 通信：DSH 的 Connection RPC 通道机制（`/arc-cln`，`authority: loopback`，仅接受本机回环页面）
- 归档集合：Host `workspaceRegistry.archivedSessionIds`（持久化状态）为主，浏览器端 `useWorkspaces` 存储兜底，取并集
- 回收站：Host 通过 `subprocess` 调用 `powershell.exe` + `Microsoft.VisualBasic.FileIO.FileSystem::DeleteDirectory(..., SendToRecycleBin)`

## 安装

> 前提：DSH Web 部署（`dsh --profile web`），Windows 系统（回收站能力依赖 Windows）。

1. 克隆 / 复制本项目到 DSH profile 的 node_modules：

   ```bash
   git clone https://github.com/<你的用户名>/dsh-archived-cleaner.git
   cp -r dsh-archived-cleaner "$HOME/.dsh/profiles/web/node_modules/"
   # 或：在 profiles/web 下执行 pnpm add <本地路径>
   ```

2. 在 `$HOME/.dsh/profiles/web/cordis.patch.yml` 追加一行（`name` 为包名）：

   ```yaml
   - id: archived-cleaner
     name: 'dsh-archived-cleaner'
   ```

3. 重启 DSH（`dsh --profile web`）。

> 若发布到 npm，把 `package.json` 的 `name` 改为带 scope 的包名（如 `@you/dsh-archived-cleaner`），
> 并同步修改 `cordis.patch.yml` 中的 `name` 与 `lib/client.js` 里的 bundle `id`。

## 使用

1. 打开左下角 **设置** → 左侧导航 **清理归档**
2. 勾选要清理的已归档会话（运行中的自动置灰跳过）
3. 点击 **「移入回收站 (n)」** → 完成后显示成功 / 失败明细
4. （可选）彻底释放空间：清空 Windows 回收站

## 依赖

| 依赖 | 用途 |
|---|---|
| `@deepseek-ai/cordis` | 插件框架 |
| `@deepseek-ai/dsh-client-connection` | Host↔Client RPC 通道 |
| `@deepseek-ai/dsh-client-runtime` | 客户端 `useWorkspaces`（归档集合兜底） |
| `@deepseek-ai/dsh-client-ui-slots` | 客户端 Slot 系统（`settings.section`） |
| `@deepseek-ai/dsh-session` / `dsh-session-query` / `dsh-workspace` | Host 侧会话与归档注册表 |
| `react` | 客户端渲染 |

全部为 peerDependencies，由 DSH 宿主提供，插件本身零运行时依赖。

## 许可

MIT
