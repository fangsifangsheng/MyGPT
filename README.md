# LocalGPT

LocalGPT 是一个运行在本机的 ChatGPT 风格网页，用来调用本机已经登录的 Codex CLI。每个新对话对应一个独立目录，上传的文件直接存入该目录，Codex 以这个目录作为工作区读取和处理文件。

## 本机启动

需要 Node.js 20 或更高版本，并确保终端中可以运行 `codex --version`。

```powershell
npm install
npm start
```

浏览器打开 <http://127.0.0.1:4317>。

也可以直接双击项目目录中的 `start-localgpt.cmd` 启动，双击 `stop-localgpt.cmd` 关闭。运行中的服务 PID 会记录在 `.localgpt.pid`，输出和错误日志在 `logs/`。

可以在启动前用环境变量覆盖默认配置：

```powershell
$env:LOCALGPT_PORT = "4317"
$env:LOCALGPT_DATA_DIR = "D:\LocalGPT-data"
$env:LOCALGPT_PASSWORD = "your-password"
npm start
```

## 手机或局域网访问

电脑和手机连接同一个 Wi-Fi，在电脑上运行：

```powershell
$env:LOCALGPT_PASSWORD = "设置一个强密码"
npm run lan
```

也可以双击 `start-localgpt-lan.cmd` 启动局域网模式；停止时仍然双击 `stop-localgpt.cmd`。

终端会显示类似下面的地址和密码：

```text
手机访问: http://192.168.1.116:4317
访问密码: 设置一个强密码
```

在手机浏览器打开该地址并输入密码即可。首次访问时如果 Windows 防火墙弹窗询问，请允许 Node.js 访问“专用网络”。如果没有弹窗，需要在 Windows 防火墙中为 TCP 4317 允许专用网络入站访问。

局域网模式监听 `0.0.0.0`，但所有 API 都要求密码认证；默认本机模式只监听 `127.0.0.1`。请不要把此端口转发到公网。

## 已实现功能

- ChatGPT 风格的桌面及移动端界面
- 新建、切换、重命名和删除对话
- 每个对话使用独立文件夹
- 多文件上传、下载、删除和文件列表
- Codex 模型及推理强度选择
- Codex 执行状态实时展示
- 使用同一个 Codex 线程继续对话
- 停止正在运行的任务
- Markdown、代码块和复制按钮
- 局域网密码登录
- 会话路径和文件路径边界保护

## 数据位置

默认数据目录是项目根目录下的 `chats`：

```text
chats/
└── chat-20260719-120000-ab12/
    ├── .localgpt/
    │   └── chat.json
    ├── 用户上传的文件.pdf
    └── Codex 创建或修改的文件.md
```

隐藏的 `.localgpt/chat.json` 保存标题、消息记录和 Codex 线程 ID。其他文件都属于用户的会话工作区，Codex 可以直接看到。

## 权限说明

Codex 使用 `workspace-write` 模式运行，工作目录限定为当前会话文件夹，并继承本机 Codex 的登录状态、模型提供商配置和其他个人配置。LocalGPT 是个人本地工具，不是面向公网或不受信任用户的多用户生产服务。重要文件请自行备份。
