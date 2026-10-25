# XSH 独立桌面 RDP 协议库评估

实施状态：XSH 已接入固定版本 FreeRDP 同进程库，实施与验证范围见 [remote-desktop.md](remote-desktop.md)。下文保留原始选型依据，不代表所有候选功能都已在 XSH 验证。

调研日期：**2026-10-25，Asia/Shanghai**。目标：用户只安装 XSH，在 XSH 内连接、显示和控制远程桌面，不启动外部 RDP 客户端，不依赖另行部署的网关。本报告仅比较协议库和原生客户端引擎；XSH 现有集成架构、渲染传输和性能方案由另一份报告负责。

## 选择建议

**建议优先验证 FreeRDP 链接库方案，作为 Windows＋macOS 产品的首选候选。** 两套库都能原生直接连接 RDP 服务器，因此“无网关”本身不能决定选型。决定因素是：FreeRDP 已发布版本中可定位到完整的 RDPGFX 解码路径、客户端通道接口及平台实现；IronRDP 已发布的高层客户端引擎仍有图形接线、证书校验和跨平台剪贴板缺口。选择 FreeRDP 的代价是 C/Rust FFI、原生依赖及随安装包维护这些依赖。这个建议是源码证据支持的工程判断，**不是已经完成兼容性、性能或打包验收的结论**。[^F1][^F2][^F3][^I1][^I4][^I5][^I8]

**IronRDP-first 可以成立，但需要明确收窄条件：** 团队优先考虑 Rust 集成，接受先做单屏基本桌面；愿意补齐证书策略、macOS 剪贴板和输入体验；并在需要 H.264 时接受锁定开发提交或自行接入独立图形模块。若要求直接采用已发布高层客户端，在两平台交付接近完整 RDP 客户端的体验，现有证据不足以支持优先选择 IronRDP。不能以“Rust”推导已经更快，也不能以“FreeRDP 历史更长”推导本项目已经稳定。[^I4][^I5][^I6][^I7][^I8][^I10]

## 已核实的版本边界

| 项目 | 本次核查基线 | 解释 |
| --- | --- | --- |
| IronRDP 发布版 | `ironrdp 0.17.0`、`ironrdp-client 0.1.0`，crates.io 显示均于 **2026-07-10** 发布；对应发布标签源码提交 `11a0810cfbbabd8b8023875a05e3041216d4b01b` | 高层客户端、独立协议 crate 和 viewer 各自有版本；不能只凭 umbrella crate 的版本号推断功能。[^B1] |
| IronRDP 开发分支 | `b69cda22ec692e212caffdbb9fe0c4e5ff1d2696`，提交时间 **2026-10-24** | 本次读取到的开发头；以下单独列出的新能力不能回填为 7 月发布版功能。[^B2] |
| FreeRDP 发布版 | **3.32.2**，GitHub 官方发布于 **2026-10-12**；提交 `97eff6ddfbbfaa8e42a126d362686bd001ff8bdc` | 官方 releases API 核查时最近的非预发行版本。下文采用这个标签，避免混入后续 master 功能。[^B3] |

使用官方仓库浅克隆、发布标签和官方 API 核对上述材料；未使用第三方产品评测作功能依据。**未编译两套库，未连接真实 RDP 主机，未在 macOS 上运行，也未测量帧率、CPU、带宽、延迟或安装包大小。** 关键源码已取得，不存在阻止本次判断的来源访问缺口。

## 原生直连与 Web/WASM 路径必须区分

| 路径 | 源码证据 | 是否满足连接层的无外部网关要求 |
| --- | --- | --- |
| IronRDP 原生 Rust 引擎 | 发布版 `connect_direct` 调用 `tokio::net::TcpStream::connect`；随后 `connect_begin`、TLS 升级和 `connect_finalize`。CredSSP 源码提供 NTLM，以及配置 Kerberos 时的 Negotiate 路径。`ironrdp-client` 自述为可复用、仅提供库的引擎，输出图像和指针事件，接收输入事件。[^I1][^I2] | **可以。** 将库编入 XSH 原生部分并由 XSH 消费事件，不需要运行 viewer、agent 或网关。是否显示在 XSH 内仍取决于宿主完成显示和输入适配。 |
| IronRDP 官方 Web/WASM 客户端 | 核查的发布版 `ironrdp-web/src/session.rs` 要求 `proxy_address`，调用 `WebSocket::open`，并执行 RDCleanPath 握手。[^I3] | **这个样例路径不满足直接 TCP 直连。** 不能把原生 Rust 的 TCP 能力自动归给浏览器/WASM 样例。若重做原生传输适配，已经是另一项集成工作。 |
| FreeRDP 原生链接库 | C API 提供连接、断开和事件循环接口；`transport.c` 有直接 TCP、TLS、NLA 路径；官方 Sample 直接链接 `freerdp-client`、`freerdp`、`winpr`。[^F1][^F2] | **可以。** 库调用不要求启动 `xfreerdp`、`wfreerdp` 或 SDL 客户端，也不要求 RD Gateway。宿主仍需接管图像、输入、证书和平台交互。 |

NLA 中的 Kerberos 可能需要域/KDC 网络环境，这是认证部署条件，不能混同于“RDP 必须经过外部网关”。两套库具备某种认证实现，也不代表所有企业登录方式均已验证。[^I2][^F2]

## 决定产品可用性的能力差异

下表中 IronRDP 默认指上述**发布版高层 `ironrdp-client`**；开发分支另列。FreeRDP 指 **3.32.2**。存在协议类型、能力字段或参考客户端代码，只证明有实施基础，不证明 XSH 接入后自动获得完整体验。

| 方面 | IronRDP 已发布高层客户端 | FreeRDP 3.32.2 |
| --- | --- | --- |
| 图形与 RDPGFX | 发布版 README 列出 raw bitmap、Interleaved RLE、RDP 6.0 bitmap compression、RemoteFX；高层 client 依赖和会话快路径未接通 H.264/AVC 的 RDPGFX 路径。仓库已有独立 `ironrdp-egfx` crate，但不能因此宣称高层 client 已提供该功能。viewer 使用 `softbuffer`，清单明确描述为无 GPU 加速。[^I4] | `libfreerdp/gdi/gfx.c` 可定位 RemoteFX、ClearCodec、Progressive、AVC420、AVC444 的实际解码调用；H.264 仍依赖编译时选择的后端。**图形路径覆盖更完整，性能优劣未实测。**[^F3] |
| 剪贴板 | CLIPRDR 协议与 Windows 原生剪贴板后端可用作集成基础；发布版原生后端仅支持 Windows，其他平台在该高层引擎中使用 stub。Windows 的文件内容、锁定相关回调明确写着尚未实现，不能承诺文件复制粘贴。文本、富文本、图片的实际双向格式仍需验证。[^I5] | 有 CLIPRDR 客户端接口；Windows 参考实现有文件描述符和文件内容流处理；macOS 参考实现有文本/NSPasteboard 接线。**不能把 Windows 文件剪贴板能力等同于 macOS 文件剪贴板已完成，更不能等同于链接核心库后自动获得系统剪贴板。**[^F4] |
| 动态分辨率与多屏 | 已注册 Display Control DVC，并有 `Resize` 输入事件。发布版 `encode_resize` 走 `encode_single_primary_monitor`；通道未就绪或不存在会返回 `None`。这支持单屏动态尺寸的实现基础，不足以承诺多屏产品。[^I6] | `DispClientContext::SendMonitorLayout` 接受显示器数量和布局数组，具备动态布局接口；图像更新接口也有桌面尺寸回调。宿主仍须处理服务器能力、DPI、布局及尺寸变化。多屏混合 DPI 未实测。[^F5] |
| 键盘、鼠标、中文 IME | 输入 crate 提供扫描码和 Unicode 操作；发布版 viewer 发送物理扫描码，却把 `WindowEvent::Ime(_)` 放在忽略分支。不能把 Unicode PDU 支持写成完整中文输入法支持。[^I7] | C API 提供扫描码、Unicode、鼠标和焦点相关事件；但 Sample 和 SDL3 的 `KeyboardSetImeStatus` 回调会记录并忽略状态。具备输入原语，不等于自动处理 XSH 的组合输入、候选框和快捷键。[^F5] |
| 证书与凭据 | 原生 TLS/NLA 确实存在，但发布版 rustls 使用 `NoCertificateVerification`，native-tls 使用 `danger_accept_invalid_certs(true)`。因此默认连通不能作为证书安全验收。CredSSP 默认 NTLM，配置 Kerberos 时切换路径；不能推导自动具备系统账户 SSO。[^I2][^I8] | 有认证回调、未知/变更证书回调，以及拒绝、仅本次接受、接受并存储的返回语义；可以嵌入 XSH 的交互和信任存储。具体域、NTLM、Kerberos及证书策略仍须在选定构建上验收。[^F2][^F5] |

### IronRDP 开发分支的实质进展

开发提交 `b69cda22…` 的 client README 明确说明：Windows 默认可通过 Media Foundation 使用系统 H.264 解码器，其他平台默认 H.264 路径需启用 bundled OpenH264；可替换自定义解码器。存在解码器时默认启用图形管线，提供 AVC420、AVC444/AVC444v2 等能力。这里已经超出“只有 PDU 类型”的阶段，**不能笼统宣称当前 IronRDP 完全不支持 H.264**；但这些改进没有包含在本报告采用的 7 月高层 client 发布版中。[^I10]

同一开发分支新增 `CertificateValidation::Strict` 配置，默认仍关闭对端证书校验。检查到的原生剪贴板模块有 Windows 和 Linux 实现，未列出 macOS 实现。采用该分支仍需承担开发提交锁定、依赖变化、功能回归及 macOS 适配验证；本轮没有验证其解码性能、硬件加速效果或完整桌面兼容性。[^I10]

## 构建、随包分发与许可证约束

| 方面 | IronRDP | FreeRDP |
| --- | --- | --- |
| Windows＋macOS 构建基础 | 发布版 CI 定义含 Windows、Linux、macOS，发布版工具链固定 Rust **1.89.0**；开发头工具链为 **1.94.1**。原生 client 可脱离 winit 使用，适合 Rust 宿主。CI 定义存在不代表本次已经成功构建，更不代表功能在各平台对等。[^I1][^I9][^I10] | CMake/C 构建；仓库配置 C11，提供 macOS 构建脚本、macOS CI 和 Windows MinGW 构建 CI。旧原生 Mac 客户端默认关闭，不能用它证明可直接嵌入 XSH。Rust 宿主需要 C FFI 或小型适配层，并匹配同一版本的头文件与库。[^F6][^F7] |
| 依赖范围 | TLS 后端需明确选择。独立协议层的 Rust 实现不代表所有可选后端均无原生依赖；OpenH264 bundled 路径需要 C 编译器和 NASM。开发分支在 Windows 可用系统 Media Foundation，macOS 的默认 H.264 选择不同。[^I9][^I10][^L2] | 主要原生依赖含 WinPR 和默认密码学路径的 OpenSSL；其他依赖取决于配置，默认智能卡模拟还触发 zlib。可选 FFmpeg、OpenH264、Media Foundation 等影响图形能力和打包。Windows Media Foundation 后端及 FFmpeg 硬件加速选项在该版本配置中标注为 experimental，不能直接保证硬件加速。[^F3][^F6] |
| 只分发 XSH | 将库及必要运行时放进 XSH 安装包，可以避免要求用户安装 viewer/agent。涉及运行时加载 codec 时，必须检验安装包是否实际包含所需组件。[^I1][^L2] | 可静态或动态链接，项目默认构建共享库；有 `minimal-library` / `full-library` 预设，可不生成外部客户端。`minimal-library` 同时关闭 OpenH264、FFmpeg、Kerberos 等可选项，**不能将最小构建成功当作所需图形和认证能力已齐全**。具体功能须显式恢复并验收。[^F6] |
| 核心许可证 | 工作区声明 **MIT OR Apache-2.0**。[^L1] | 核心 **Apache-2.0**。[^L1] |

许可证范围须按最终依赖清单判断。IronRDP 的 OpenH264 文档明确区分源码编译与 Cisco 官方二进制的许可/专利覆盖条件，并给出由用户单独下载官方二进制的分发建议；**这不是满足“只安装 XSH”的现成方案，也不意味着使用任意 OpenH264 构建都自动取得相同覆盖**。FFmpeg 官方说明其许可取决于所启用的可选组件，可能从 LGPL 涉及 GPL。选型时应先确定系统解码器或可随包分发的解码器及相应条件，再锁定构建配置。此处仅记录上游说明，不作特定商业分发的法律结论。[^L2]

## 改变选型结论之前必须通过的验证门槛

以下是建议的验收要求，**当前全部未完成**：

1. **独立运行与直连：** 在 Windows 和 macOS 干净环境，只安装 XSH，直接连接目标 RDP TCP 端口并完成 TLS/NLA。验证不启动外部客户端，不依赖外部网关，不要求用户另装或另下载必要 codec。测试账号密码错误、网络不可达与服务器拒绝时的错误回传。
2. **证书和身份：** 有效证书、名称不匹配、自签名、过期与证书变更均有明确结果。需要域/Kerberos 时使用真实目标环境验证。IronRDP 不能沿用发布版默认跳过校验的行为；开发头应明确开启严格策略，并验证所选 TLS 后端的实际行为。
3. **图形：** 记录最终协商到的图形模式，覆盖目标 Windows 服务器的默认策略、bitmap 回退及所需 AVC420/AVC444 路径。测量滚动、文本、视频/动画、多会话下的 CPU、帧呈现及资源占用；不预设任一库达到某个帧率或带宽。
4. **剪贴板与尺寸：** 两平台双向中文/多行文本必须可用；图片、富文本、文件分别明确纳入或排除首发范围。验证连接后首次剪贴板、断连、多会话切换；动态尺寸必须真正改变远端桌面，并处理服务器未开放 Display Control 的情形。多屏若纳入范围，另验布局和混合 DPI。
5. **输入和生命周期：** 中文 IME 组合/提交、物理键与 Unicode、AltGr、修饰键、组合快捷键、焦点丢失及鼠标坐标均需实测。断连、重连、关闭会话与多会话并行须释放线程、句柄、缓冲区和通道资源。
6. **可复现发行：** Windows 和 macOS 各自完成锁定版本、Release 构建、必要依赖随包、签名及更新回归。FreeRDP 的最小预设和 IronRDP 的 Rust 构建通过，都不能代替以上功能验收。

**决策规则：** 若 FreeRDP 在两平台通过这些门槛，优先采用链接库路线；只有其 FFI/分发成本被实际证明不可接受，或 IronRDP 在选定提交上补齐必需能力并通过同一验收集，才有充分依据转为 IronRDP-first。若产品先限定 Windows 单屏基本桌面，IronRDP 可以提前进入候选验证，但仍必须先处理证书校验。此规则不包含工期或未经测量的性能承诺。

## 一手来源

以下源码 URL 固定到已检查提交；API/官网文档记录本次访问时状态。

[^B1]: crates.io 官方 API：[ironrdp](https://crates.io/api/v1/crates/ironrdp)、[ironrdp-client](https://crates.io/api/v1/crates/ironrdp-client)；[viewer 发布记录](https://github.com/Devolutions/IronRDP/releases/tag/ironrdp-viewer-v0.1.0)；[发布提交](https://github.com/Devolutions/IronRDP/commit/11a0810cfbbabd8b8023875a05e3041216d4b01b)。
[^B2]: [IronRDP 开发分支检查提交](https://github.com/Devolutions/IronRDP/commit/b69cda22ec692e212caffdbb9fe0c4e5ff1d2696)。
[^B3]: [FreeRDP 官方 releases API](https://api.github.com/repos/FreeRDP/FreeRDP/releases?per_page=3)；[3.32.2 发布记录](https://github.com/FreeRDP/FreeRDP/releases/tag/3.32.2)；[发布提交](https://github.com/FreeRDP/FreeRDP/commit/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc)。
[^I1]: IronRDP 发布版：[client README](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/README.md)；[client 输入/输出事件及运行时](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/src/rdp.rs#L49-L114)。
[^I2]: IronRDP 发布版：[原生 TCP 直连](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/src/rdp.rs#L430-L448)；[TLS/连接完成](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/src/rdp.rs#L535-L573)；[CredSSP NTLM/Kerberos 选择](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-connector/src/credssp.rs#L141-L165)。
[^I3]: IronRDP 发布版：[WASM session 中的 proxy_address、WebSocket 和 RDCleanPath](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-web/src/session.rs)；重点位置为第 365、449、1601、1626 行及后续握手实现。
[^I4]: IronRDP 发布版：[README 图形支持列表](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/README.md)；[client Cargo.toml](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/Cargo.toml)；[快路径 codec 分派](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-session/src/fast_path.rs#L467-L531)；[独立 egfx README](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-egfx/README.md)；[viewer 构建与 softbuffer](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-viewer/Cargo.toml)。
[^I5]: IronRDP 发布版：[原生剪贴板 README](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-cliprdr-native/README.md)；[Windows/非 Windows 后端选择](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/src/rdp.rs#L114-L200)；[Windows 尚未实现的文件回调](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-cliprdr-native/src/windows/cliprdr_backend.rs#L75-L88)。
[^I6]: IronRDP 发布版：[单主显示器 resize 及通道不可用行为](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-session/src/active_stage.rs#L301-L332)；[client Display Control 注册和 Resize 处理](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/src/rdp.rs)。
[^I7]: IronRDP 发布版：[输入原语](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-input/src/lib.rs)；[viewer 键盘处理](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-viewer/src/app.rs#L174-L191)；[IME 忽略分支](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-viewer/src/app.rs#L322-L333)。
[^I8]: IronRDP 发布版：[rustls 无证书校验实现](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-tls/src/rustls.rs)；[native-tls 接受无效证书](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-tls/src/native_tls.rs#L7-L19)。
[^I9]: IronRDP 发布版：[工具链](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/rust-toolchain.toml)；[跨平台 CI 定义](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/.github/workflows/ci.yml)；[TLS features](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-client/Cargo.toml)。
[^I10]: IronRDP 开发提交：[client README：证书策略与 H.264/图形管线](https://github.com/Devolutions/IronRDP/blob/b69cda22ec692e212caffdbb9fe0c4e5ff1d2696/crates/ironrdp-client/README.md)；[client features 和平台依赖](https://github.com/Devolutions/IronRDP/blob/b69cda22ec692e212caffdbb9fe0c4e5ff1d2696/crates/ironrdp-client/Cargo.toml)；[原生剪贴板平台模块](https://github.com/Devolutions/IronRDP/blob/b69cda22ec692e212caffdbb9fe0c4e5ff1d2696/crates/ironrdp-cliprdr-native/src/lib.rs)；[开发工具链](https://github.com/Devolutions/IronRDP/blob/b69cda22ec692e212caffdbb9fe0c4e5ff1d2696/rust-toolchain.toml)。
[^F1]: FreeRDP 3.32.2：[公开客户端 API](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/freerdp.h)；[嵌入 Sample](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/Sample/tf_freerdp.c)；[Sample 的库链接](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/Sample/CMakeLists.txt)。
[^F2]: FreeRDP 3.32.2：[TCP/TLS/NLA transport](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/transport.c)；[安全协商](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/nego.c)；[NLA](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/nla.c)；[WinPR SSPI/Kerberos 构建选择](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/libwinpr/sspi/CMakeLists.txt)。
[^F3]: FreeRDP 3.32.2：[GFX 实际解码路径](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/gdi/gfx.c)；[H.264 后端构建与 experimental 标记](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/codec/CMakeLists.txt)；[功能选项及默认值](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/cmake/ConfigOptions.cmake)。
[^F4]: FreeRDP 3.32.2：[CLIPRDR 客户端接口](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/client/cliprdr.h)；[Windows 剪贴板实现](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/Windows/wf_cliprdr.c)；[macOS 文本剪贴板实现](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/Mac/Clipboard.m)。
[^F5]: FreeRDP 3.32.2：[Display Control 客户端接口](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/client/disp.h)；[输入 API](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/input.h)；[认证与证书回调](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/freerdp.h)；[Sample IME 回调](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/Sample/tf_freerdp.c#L133-L145)；[SDL3 输入实现](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/SDL/SDL3/sdl_input.cpp)。
[^F6]: FreeRDP 3.32.2：[CMake 主配置与依赖](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/CMakeLists.txt)；[C11](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/cmake/ProjectCStandard.cmake)；[静态/共享库配置](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/cmake/CommonConfigOptions.cmake)；[library 构建预设及其关闭的功能](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/CMakePresets.json)；[官方编译文档](https://github.com/FreeRDP/FreeRDP/wiki/Compilation)。
[^F7]: FreeRDP 3.32.2：[macOS CI](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/.github/workflows/macos.yml)；[macOS bundle 构建脚本](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/scripts/bundle-mac-os.sh)；[MinGW 静态和共享构建 CI](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/.github/workflows/mingw.yml)；[平台客户端选择和 Mac 默认关闭](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/CMakeLists.txt)。
[^L1]: [IronRDP 发布版工作区许可证声明](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/Cargo.toml)；[FreeRDP 3.32.2 LICENSE](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/LICENSE)。
[^L2]: [IronRDP OpenH264 集成与分发说明](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-egfx/README.md)；[对应第三方 notices](https://github.com/Devolutions/IronRDP/blob/11a0810cfbbabd8b8023875a05e3041216d4b01b/crates/ironrdp-egfx/THIRD_PARTY_NOTICES)；[FFmpeg 官方许可说明](https://ffmpeg.org/legal.html)。
