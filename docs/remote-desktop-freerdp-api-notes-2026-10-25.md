# FreeRDP 3.32.2：XSH 原生桥接 API 配方

核查日期：2026-10-25。只读检查官方本地 checkout，HEAD 已确认是 **97eff6ddfbbfaa8e42a126d362686bd001ff8bdc**。以下只涉及文本剪贴板、动态尺寸、证书交互和内建通道；未读取 XSH 实现，未修改代码，未安装依赖或构建。片段中的宿主状态/回调名称是接线示意，FreeRDP 类型和函数名取自该提交；本次未编译片段。

## 1. 初始化顺序与内建通道

**关键版本陷阱：不要只在 PreConnect 中调用 load_addins。** 该版本连接流程在 PreConnect 后调用 utils_reload_channels，销毁旧 channels、重建后再调用 instance->LoadChannels。裸 freerdp_new/context_new 路径应设置 `instance->LoadChannels = freerdp_client_load_channels`，或设置先执行下述内建入口预检、再调用该函数的包装器。PreConnect 负责设置和订阅事件；不要重复加载。common client context 路径本来就设置此回调和 provider。[core/freerdp.c:120–136][load-order]、[core/utils.c:574–595][reload]、[client/common/client.c:165–185,233–242][common-init]。

进程级注册一次：`freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0)`，返回 0 才成功；不要在并发会话间反复替换全局 provider。头文件：`<freerdp/addin.h>`、`<freerdp/client/channels.h>`、`<freerdp/client.h>`。设置 API 使用 `freerdp_settings_set_bool/set_uint32`，逐次检查 BOOL 返回值。[provider][load-function]

| CMake 项/内建项 | 此任务需要的配置与含义 |
| --- | --- |
| WITH_CLIENT_COMMON / WITH_CHANNELS / WITH_CLIENT_CHANNELS | 均 ON；WITH_CLIENT 可 OFF，无需生成或运行 CLI；WITH_CLIENT_INTERFACE 不是本方案的必需项。[build-options] |
| cliprdr / drdynvc / disp | `CHANNEL_CLIPRDR=ON, CHANNEL_CLIPRDR_CLIENT=ON, CHANNEL_DRDYNVC=ON, CHANNEL_DRDYNVC_CLIENT=ON, CHANNEL_DISP=ON, CHANNEL_DISP_CLIENT=ON`。disp 的构建依赖 drdynvc。[channel-build] |
| rdpgfx | 若主实现启用图形管线，再开启 `CHANNEL_RDPGFX=ON, CHANNEL_RDPGFX_CLIENT=ON`；它不是文本剪贴板或 resize 的独立必需项。[addin-settings] |
| 静态链接 | `BUILD_SHARED_LIBS=OFF` 是静态链接选择；不要臆造 WITH_STATIC_CHANNELS。该提交将选中的 client channel 构建为 OBJECT，再把生成的 tables.c 和通道对象纳入 freerdp-client；使用官方 CMake 的 `freerdp-client, freerdp, winpr` 目标及传递依赖，不必另找外部插件文件。[channel-objects][channel-tables][client-link] |

注册后、任何 common loader 调用前，直接调用 `freerdp_channels_load_static_addin_entry(name, NULL, NULL, flags)` 预检：cliprdr、drdynvc 用 `FREERDP_ADDIN_CHANNEL_STATIC | FREERDP_ADDIN_CHANNEL_ENTRYEX`；disp 和可选 rdpgfx 用 `FREERDP_ADDIN_CHANNEL_DYNAMIC`。任一必需项返回 NULL 就终止连接；不要继续到 common loader。drdynvc 的 dynamic 指 RDP 动态虚拟通道，不代表必须动态加载 DLL。[static-lookup]

**provider 注册本身并不禁止外部插件：** `freerdp_load_channel_addin_entry` 在静态查找失败后会回退动态加载。因此上述预检必须覆盖所有实际启用的通道，并限制 StaticChannelArray/DynamicChannelArray 及重定向设置为宿主允许的内建清单。编入的 AINPUT 会被 common loader 无条件加入；若只允许这几项，配置 `CHANNEL_AINPUT=OFF` 并关闭其余未使用功能，或把其全部实际入口加入预检。不要把“返回 NULL 的白名单 provider”误当作禁用回退的开关。这是该版本 loader 的真实限制，无需启动 helper 或外部客户端。[provider][addin-settings][addin-finish]

连接前至少设置：`FreeRDP_RedirectClipboard=TRUE`；`FreeRDP_ClipboardFeatureMask=CLIPRDR_FLAG_LOCAL_TO_REMOTE | CLIPRDR_FLAG_REMOTE_TO_LOCAL`（文本双向，不启用文件位）；`FreeRDP_SupportDisplayControl=TRUE`；`FreeRDP_DynamicResolutionUpdate=TRUE`。common loader 按这些设置加入 cliprdr/disp，有 DVC 时自动加载 drdynvc。宏位值在 `include/freerdp/settings_types.h:343–350`。[addin-settings][addin-finish]

通过 `PubSub_SubscribeChannelConnected/Disconnected(context->pubSub, handler)` 订阅，返回负值即失败；重连时避免重复订阅，在对应生命周期解除。事件函数形如 `void on_connected(void* context, const ChannelConnectedEventArgs* e)`。cliprdr 比较 `CLIPRDR_SVC_CHANNEL_NAME`；disp 必须比较 `DISP_DVC_CHANNEL_NAME`（完整名称 Microsoft::Windows::RDS::DisplayControl），不要比较短名 disp。接口取自 `e->pInterface`。[channel-events]

## 2. CLIPRDR：只实现 CF_UNICODETEXT

连接事件取得 `CliprdrClientContext* clip = (CliprdrClientContext*)e->pInterface`；保存指针，设 `clip->custom` 为本会话状态；安装下表回调。不要改写 `handle` 或库已提供的 Client* 发送函数，也不要同时套用会占用 custom 的文件剪贴板 helper。所有这些回调返回 `UINT`，成功为 `CHANNEL_RC_OK=0`，不能按 BOOL 的 TRUE 语义返回 1。类型见 [client/cliprdr.h:40–110][clip-types]；PDU 字段见 [channels/cliprdr.h:97–184][clip-pdus]。

| 宿主安装的字段 | 最小行为 |
| --- | --- |
| ServerCapabilities | 接收/记录能力，返回 CHANNEL_RC_OK；插件先解析服务器能力，ClientCapabilities 会按服务端支持过滤能力位。[clip-cap-send] |
| MonitorReady | 此时发送 ClientCapabilities，成功后标记 clip_ready，再发送当前本地文本格式列表。ChannelConnected 本身不等于剪贴板握手已就绪。[clip-ready] |
| ServerFormatList | 扫描借用的 formats，查找 CF_UNICODETEXT=13；先发 ClientFormatListResponse/CB_RESPONSE_OK；有 Unicode 文本时可再发 ClientFormatDataRequest 请求 13，没有则不请求。退出前复制任何需保留的信息。[clip-list-recv] |
| ServerFormatListResponse | 检查服务端对本地公告的 CB_RESPONSE_OK/FAIL，更新状态/记录失败；不要当成数据正文。[clip-types] |
| ServerFormatDataRequest | 从宿主持有的本地 UTF-8 文本快照生成 UTF-16LE 响应；不支持的 requestedFormatId 返回 ClientFormatDataResponse/CB_RESPONSE_FAIL、dataLen=0、data=NULL。[clip-data-recv][clip-data-send] |
| ServerFormatDataResponse | 检查 CB_RESPONSE_OK、自己的 pending 请求、字节长度和 UTF-16 终止；在回调内复制/解码为自有 UTF-8，再交给宿主剪贴板。[clip-data-recv][clip-data-borrow] |

能力与本地公告的准确填法（常量来自 `<freerdp/channels/cliprdr.h>`；CF_UNICODETEXT 来自 `<winpr/user.h>`）：[clip-ready][clip-pdus]

~~~c
CLIPRDR_GENERAL_CAPABILITY_SET g = { CB_CAPSTYPE_GENERAL, CB_CAPSTYPE_GENERAL_LEN, CB_CAPS_VERSION_2, CB_USE_LONG_FORMAT_NAMES };
CLIPRDR_CAPABILITIES caps = { .common = { CB_CLIP_CAPS, 0, 0 }, .cCapabilitiesSets = 1, .capabilitySets = (CLIPRDR_CAPABILITY_SET*)&g };
UINT rc = clip->ClientCapabilities(clip, &caps); /* 检查 rc，再发送列表 */
CLIPRDR_FORMAT fmt = { .formatId = CF_UNICODETEXT, .formatName = NULL };
CLIPRDR_FORMAT_LIST list = { .common = { CB_FORMAT_LIST, 0, 0 }, .numFormats = 1, .formats = &fmt };
rc = clip->ClientFormatList(clip, &list); /* 无本地文本时 numFormats=0, formats=NULL */
~~~

ServerFormatList 回调使用 `CLIPRDR_FORMAT_LIST_RESPONSE ack = { .common = { CB_FORMAT_LIST_RESPONSE, CB_RESPONSE_OK, 0 } }`，调用 `clip->ClientFormatListResponse(clip, &ack)`；成功后构造 `CLIPRDR_FORMAT_DATA_REQUEST req = { .common = { CB_FORMAT_DATA_REQUEST, 0, 4 }, .requestedFormatId = CF_UNICODETEXT }` 并调用 `ClientFormatDataRequest`。先建立本会话的 pending 标记/格式/远端列表代次，发送失败撤销；同一时刻最多一个未完成请求；列表更新期间保留旧 in-flight 占位并排队最新意图，旧响应丢弃后才发新请求，不要清空 pending 后立即重发。**响应 PDU 无 formatId；clip->lastRequestedFormatId 是插件在收到服务器请求本地数据时更新的，不能用来关联自己的远端读取。** 远端格式更新或断连后，丢弃旧代次响应。[clip-pdus][clip-data-recv]

发送 Unicode 正文：用 `WCHAR* w = ConvertUtf8NToWCharAlloc(utf8, utf8_bytes, &n)`，检查 NULL；n 是不含终止符的 UTF-16 单元数，不是字节数。检查 `n <= UINT32_MAX / sizeof(WCHAR) - 1` 后，响应填 `common={CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_OK, (UINT32)((n+1)*sizeof(WCHAR))}`、`requestedFormatData=(const BYTE*)w`；调用 `ClientFormatDataResponse` 返回后 `free(w)`。空字符串也发送两字节 NUL；macOS 不要用通常为 32 位的系统 wchar_t 替代 WinPR 的 WCHAR。[unicode][unicode-impl][clip-data-send]

接收正文的 `requestedFormatData` 直接借用接收流，不能 free、跨回调保留或把裸指针交给异步 UI；formats 和 formatName 也在回调返回后释放。对 CF_UNICODETEXT 要求非空指针、dataLen>=2、偶数字节且在限定长度内找到 UTF-16 NUL；先复制为对齐的 WCHAR 缓冲区，再用 `ConvertWCharNToUtf8Alloc(w, units_before_nul, &utf8_len)`，完成后 free 转换结果。不要对网络数据直接 wcslen；缺终止符/非法转换的处理策略应明确为拒绝该正文。发包函数把数据同步拷入自有流，所以调用期间有效的栈结构/正文缓冲可在调用返回后释放；这不等于网络发送已完成。[clip-list-recv][clip-data-borrow][clip-data-send][unicode]

本地剪贴板变更只在 clip_ready 后重发格式列表，远端下发文本写入本地后需抑制本地更新回声。Disconnected 时使 clip_ready/pending 失效、清空接口指针，撤销 custom/回调引用；接口归库所有，不能由宿主 free。宿主状态要活到所有回调退出；不要假定通道回调都在 UI 或同一个线程。[clip-types][channel-events]

## 3. Display Control 动态尺寸

在 DISP_DVC_CHANNEL_NAME 的 Connected 事件取 `DispClientContext* disp = (DispClientContext*)e->pInterface`，设 `disp->custom`、`disp->DisplayControlCaps = on_caps`。签名：`UINT on_caps(DispClientContext*, UINT32 MaxNumMonitors, UINT32 MaxMonitorAreaFactorA, UINT32 MaxMonitorAreaFactorB)`。保存三个上限并在有效 caps 到达后设置 disp_ready，再发送最新待处理布局；之前只缓存目标尺寸。库内部 SendMonitorLayout 直接解引用 channel_callback，不应仅凭非空 context 或函数指针就提前调用。[disp-types][disp-impl][disp-reference]

发送结构为 `DISPLAY_CONTROL_MONITOR_LAYOUT m={0}`：Flags=DISPLAY_CONTROL_MONITOR_PRIMARY、Left=Top=0、Width/Height=像素尺寸、PhysicalWidth/Height=经过校验的毫米值、Orientation=ORIENTATION_LANDSCAPE、DesktopScaleFactor=100、DeviceScaleFactor=100；随后 `UINT rc = disp->SendMonitorLayout(disp, 1, &m)`。真实 DPI/旋转应由宿主代入，mm 不可直接填像素。头文件规定宽高 200..8192；实现把宽度向偶数下调并夹限、截断显示器数量，但不应依赖它纠正非法布局或证明已处理所有面积/缩放约束；预先校验宽高、MaxNumMonitors 及 caps，面积限制策略仍需按目标服务器验证。[disp-fields][disp-impl][disp-layout-reference]

按会话串行化 resize 写入、合并快速拖动产生的重复尺寸；CHANNEL_RC_OK 仅代表此发送调用成功，之后仍等主实现的 DesktopResize/实际新帧确认远端尺寸。Disconnected 清除 disp_ready 和接口，重连重新等 caps；若服务端不开放该 DVC，报告不支持动态尺寸，不能通过只修改本地 DesktopWidth/Height 宣称已经远端 resize。参考客户端同样等 activated 后才发送。[disp-impl][disp-reference]

## 4. 证书用户决策与可取消的同步等待

推荐普通 FreeRDP 信任存储路径：安装下面两个 Ex 回调，`instance->VerifyX509Certificate=NULL`，ExternalCertificateManagement=FALSE，IgnoreCertificate=FALSE，AutoAcceptCertificate=FALSE，AutoDenyCertificate=FALSE，AuthenticationLevel=2；希望得到指纹时 CertificateCallbackPreferPEM=FALSE。全部在连接前设置，并将 `FreeRDP_UseCommonStdioCallbacks=FALSE`，避免 common ClientStart 重新安装 stdio 回调。若走 common context 初始化，要在其默认回调安装后覆盖，否则仍可能使用 CLI/stdio 交互。[cert-init][cert-tls][common-init]

~~~c
DWORD on_unknown(freerdp* instance, const char* host, UINT16 port,
                 const char* common_name, const char* subject,
                 const char* issuer, const char* fingerprint, DWORD flags);
DWORD on_changed(freerdp* instance, const char* host, UINT16 port,
                 const char* common_name, const char* subject, const char* issuer,
                 const char* new_fingerprint, const char* old_subject,
                 const char* old_issuer, const char* old_fingerprint, DWORD flags);
/* instance->VerifyCertificateEx = on_unknown;
   instance->VerifyChangedCertificateEx = on_changed; */
~~~

两者均返回 **0=拒绝，1=接受并写入 FreeRDP 证书存储，2=仅本会话接受**；返回 1 时写存储失败会导致验证失败。正常可信证书不必进入这些异常决策回调。已有 VerifyX509Certificate 会优先于 Ex，故上面的 NULL 有实际意义。host 是库的验证目标名称（设置 CertificateName 时可能被覆盖），应与 port、证书 common_name 分开展示；指纹默认由 SHA-256 生成。[cert-signatures][cert-tls][cert-name][fingerprint]

flags 必须按位解释：LEGACY=0x02、REDIRECT=0x10、GATEWAY=0x20、CHANGED=0x40、MISMATCH=0x80、MATCH_LEGACY_SHA1=0x100、FP_IS_PEM=0x200。FP_IS_PEM 置位时 fingerprint 参数实际为 PEM；变更回调对应新/旧参数均按这个标志解释。PreferPEM=TRUE 也不保证所有历史存储分支都给 PEM，必须检查 flags。所有 const char* 都是借用：emit 给异步 UI 前深拷贝，回调返回后不能继续访问。[cert-flags][cert-signatures][cert-tls]

**同步等待配方是宿主设计，不是 FreeRDP 自带异步证书 API：** 在连接工作线程的证书回调建立 request_id+会话代次，复制证书信息并发给 UI；用 WinPR 自建 decisionReady event 等待结果，同时等待库的 abort event。可用 `HANDLE hs[2]={freerdp_abort_event(instance->context), decisionReady}; DWORD wr=WaitForMultipleObjects(2, hs, FALSE, timeout_ms);` 只有 wr==WAIT_OBJECT_0+1 且 `!freerdp_shall_disconnect_context(context)` 时读取受锁/原子保护的决策并映射 0/1/2；其他结果拒绝。不要在持有会话全局锁时等待，也不要让 UI 的响应命令排到这个被阻塞的连接线程才执行。[abort-api][abort-impl][wait-api]

取消/关闭连接时另一线程调用 `freerdp_abort_connect_context(context)`，它设置 CONNECT_CANCELLED 并置位 abort event，唤醒上述等待；UI 响应写决策后 SetEvent(decisionReady)。丢弃迟到/错误代次的响应；超时拒绝。等待退出前禁止释放 context；worker 返回后再清理。只 CloseHandle 自有 decisionReady，不能关闭库的 abort event。不要把仅调用 abort 当作能唤醒任意 std::condition_variable 的保证。[abort-api][abort-impl]

若改用 ExternalCertificateManagement=TRUE，必须安装 `int VerifyX509Certificate(freerdp*,const BYTE* pem,size_t length,const char* host,UINT16 port,DWORD flags)`，宿主自己承担完整链/名称/信任策略与持久化；该分支对正返回值做连接内 accept_cert，不走上面 Ex 分支的磁盘存储语义。不要在这条路径机械理解“返回 1 就自动保存到 XSH 信任库”。[cert-signatures][cert-external]

## 固定提交来源

[load-order]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/freerdp.c#L120-L136
[reload]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/utils.c#L574-L595
[common-init]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/common/client.c#L135-L242
[load-function]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/common/client.c#L2400-L2411
[provider]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/common/addin.c#L356-L384
[build-options]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/cmake/ConfigOptions.cmake#L54-L77
[channel-build]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/CMakeLists.txt#L21-L62
[channel-objects]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/CMakeLists.txt#L172-L190
[channel-tables]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/client/CMakeLists.txt#L28-L165
[client-link]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/common/CMakeLists.txt#L20-L105
[static-lookup]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/client/addin.c#L441-L505
[addin-settings]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/common/cmdline.c#L6198-L6270
[addin-finish]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/common/cmdline.c#L6508-L6531
[channel-events]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/SDL/SDL3/sdl_channels.cpp#L35-L110
[clip-types]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/client/cliprdr.h#L40-L110
[clip-pdus]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/channels/cliprdr.h#L97-L184
[clip-ready]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/SDL/SDL3/sdl_clip.cpp#L444-L484
[clip-cap-send]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/cliprdr/client/cliprdr_main.c#L561-L615
[clip-list-recv]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/cliprdr/client/cliprdr_format.c#L125-L180
[clip-data-recv]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/cliprdr/client/cliprdr_format.c#L214-L285
[clip-data-borrow]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/cliprdr/cliprdr_common.c#L340-L353
[clip-data-send]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/cliprdr/client/cliprdr_main.c#L824-L882
[unicode]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/include/winpr/string.h#L430-L488
[unicode-impl]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/libwinpr/crt/unicode.c#L550-L641
[disp-types]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/client/disp.h#L32-L45
[disp-fields]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/channels/disp.h#L30-L72
[disp-impl]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/disp/client/disp_main.c#L62-L268
[disp-reference]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/SDL/SDL3/sdl_disp.cpp#L419-L481
[disp-layout-reference]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/client/SDL/SDL3/sdl_disp.cpp#L208-L274
[cert-init]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/settings.c#L1018-L1031
[cert-signatures]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/freerdp.h#L232-L315
[cert-flags]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/freerdp.h#L65-L73
[cert-tls]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/crypto/tls.c#L2007-L2181
[cert-name]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/crypto/tls.c#L1892-L1954
[fingerprint]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/crypto/certificate.c#L1463-L1470
[cert-external]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/crypto/tls.c#L1820-L1893
[abort-api]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/freerdp.h#L639-L658
[abort-impl]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/utils.c#L360-L385
[wait-api]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/include/winpr/synch.h#L212-L237
