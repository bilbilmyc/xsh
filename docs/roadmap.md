# XSH Roadmap

## 已完成：MVP + V2 核心能力

- Rust workspace、Tauri 2、React/xterm.js 桌面架构
- SQLite 会话目录与 XSH AES-256-GCM 自建凭据库
- 密码、OpenSSH Key、SSH Agent、keyboard-interactive 认证
- TOFU Known Hosts、SHA-256 指纹和 Host Key 变化阻断
- `~/.ssh/config` 导入、连接诊断、错误分类、脱敏诊断摘要、ProxyJump 和端口转发；端口转发支持按会话保存 profile、自动启动和重连恢复
- 多标签常驻 SSH、标签锁定与关闭保护、自定义标签颜色、左右/上下分屏、命名工作区、密码加密工作区导入/导出和命令广播；启动进入默认欢迎窗口，不自动恢复上次会话
- 自动重连、Keepalive、日志、搜索、字体缩放和可配置剪贴板行为
- 命令中心、命令历史、最近连接、快捷命令分组/搜索/快捷键
- 快捷命令敏感内容拒绝保存与旧数据安全清理
- SFTP 文件/目录递归传输、非空目录递归删除、多选、批量操作、拖拽上传、远程编辑、真实并发队列、冲突策略、取消和重试
- 终端输出端到端 ACK 背压、4 MiB 滚动日志上限、SFTP 上传/下载断点续传和传输目标 artifact 租约
- SFTP 远端兼容替换的 journal/installed marker 恢复、rename/rollback 故障注入和有归属证明的 orphan backup 清理
- SFTP 全局/单主机公平并发调度、暂停重排、上传/下载独立聚合限速和后台传输管理
- 绑定目标/ProxyJump 端点与完整公钥的结构化 Host Key 确认
- 内置 VNC/RDP：独立会话入口与应用内桌面标签，支持直连和可选 SSH 隧道；VNC 使用 noVNC，RDP 使用随包携带的同进程原生库，包含证书确认、画面与输入、远端鼠标图案、文本剪贴板、自动 / 预设分辨率与通道能力提示。原生夹具覆盖 CLIPRDR / DISP / 指针与隔离的 NLA 正误密码认证。SSH 会话也可附加内置桌面。远程桌面路径不启动外部查看器或网关
- 会话目录创建、重命名、删除、单项/批量拖拽整理，会话批量移动/收藏/删除、环境/自动重连/标签批量编辑，以及同名或相同连接目标保存前提示
- macOS 免费个人版打包、Windows 构建脚本和跨平台 CI

## 下一阶段：实机质量与发布工程

1. Windows 10/11 x64 实机安装、WebView2、字体、剪贴板、双跳 Host Key、终端背压和 SSH/SFTP 回归测试
2. macOS 长时间多标签稳定性、睡眠唤醒、网络切换和大文件传输压力测试
3. 工作区与会话配置的跨机器联合迁移向导（合并密码输入、预览、冲突策略和凭据库全量恢复）
4. 会话批量终端配置编辑和导入冲突可视化
5. 完整键盘焦点移动、屏幕阅读器回归和高 DPI/多显示器视觉验收
6. 可选的本地诊断日志导出与性能可观测性
7. 如未来需要公开分发，再加入 Apple 公证与 Windows 代码签名
8. Windows RDP / xrdp 的 NLA、图形通道与动态分辨率，以及不同 VNC 服务端的真实环境兼容性验证；macOS 内置原生库的实机打包验证

## 明确不做

SSH1、Telnet、Rlogin、X11 forwarding、ZMODEM、Kerberos、PKCS#11、云同步和团队共享凭据暂不进入当前版本。远程桌面音频 / 设备 / 文件重定向、RemoteApp、多显示器和 RD Gateway 暂未接入。
