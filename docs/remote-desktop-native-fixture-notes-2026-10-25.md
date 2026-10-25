# 进程内 loopback FreeRDP peer 最小夹具

日期：2026-10-25。唯一源码基准：FreeRDP 3.32.2，本机 `C:/Users/Soren/AppData/Local/Temp/xsh-rdp-assessment-20261025-freerdp`，commit `97eff6ddfbbfaa8e42a126d362686bd001ff8bdc`。下文是源码确认的 API 与可移入测试 harness 的 C 轮廓，**本轮没有编译或运行这些片段**；没有检查或修改 XSH 实现。

## 结论与测试边界

现有 core 足够搭建真正的 TCP/TLS RDP peer：进程内监听 `127.0.0.1:0`，接受连接，把已连接 socket 交给 `freerdp_peer_new(int)`，初始化 context/settings/callbacks，再驱动 peer 状态机。**没有 `peer->Accept` 方法**；这里的 accept 是 TCP `accept()`。官方 listener 也是这样创建 peer。[S1][S2]

**`WITH_SERVER=OFF` 仍编译 core `peer.c`、`listener.c`、`server.c`**。该开关控制根目录是否进入 `server/`，不控制 core peer；最小 TLS、原始 bitmap、输入、断开测试不需要 `freerdp-server` channel 库、系统 RDP 服务、外部客户端程序或 gateway。[S3][S4]

先固定为 TLS-only、320×240、24bpp、关闭 RFX/NSCodec/RDPGFX；在 `Activate` 发送一个 64×64 单色原始 bitmap。它验证 TLS→协议激活→客户端解码/画面→输入→断开，**不覆盖 NLA、Windows 登录、RDPGFX/H.264 或 channel 功能**。核心路径先跑通，再添加这些测试。

## 最小运行顺序

1. 测试进程初始化 Winsock；调用 `winpr_InitializeSSL(WINPR_SSL_INIT_DEFAULT)` 一次。官方 sample 也初始化此 SSL 层。[S5]
2. 用下节 helper 在内存生成本次测试的 PEM cert/key。不要启动 `openssl` 或 makecert 程序。
3. `socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)` → `bind(127.0.0.1, port=0)` → `listen(..., 1)` → `getsockname()` 取实际端口；把端口交给同一进程内的原生客户端线程。
4. 带期限等待监听 socket 可读，然后 `accept()`；关闭监听 socket。Windows `SOCKET` 比 `int` 宽，交给 `freerdp_peer_new` 前检查不是 `INVALID_SOCKET`，且 `(UINT_PTR)accepted <= INT_MAX`。
5. `freerdp_peer_new((int)accepted)` → 设置 `ContextSize` → `freerdp_peer_context_new()` → settings/回调 → `Initialize()`。之后启动下面的 peer worker；客户端与 worker 必须能够并行运行。
6. 客户端强制允许本测试 TLS-only，并匹配 320×240/24bpp；证书决策只授权本次 loopback 测试证书。用客户端真实解码帧断言逻辑像素 `(32,32)` 为 `RGB #c08020`，再发送按键 down/up、鼠标移动/按下/释放，然后主动断开。
7. worker 结束后检查 trace 中的 PostConnect、画面发送和输入记录，再释放。服务端发送成功本身不能替代客户端像素断言。

Windows 监听片段（放在 harness 错误处理内；每个 socket 失败分支均须关闭已创建的句柄）：

```c
/* Winsock headers must precede headers that can include windows.h. */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <limits.h>
WSADATA ws;
if (WSAStartup(MAKEWORD(2, 2), &ws) != 0) goto fail;
SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
if (ls == INVALID_SOCKET) goto fail;
struct sockaddr_in a = { 0 };
a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
a.sin_port = 0;
if (bind(ls, (const struct sockaddr*)&a, sizeof(a)) == SOCKET_ERROR) goto fail;
if (listen(ls, 1) == SOCKET_ERROR) goto fail;
int alen = sizeof(a);
if (getsockname(ls, (struct sockaddr*)&a, &alen) == SOCKET_ERROR) goto fail;
UINT16 port = ntohs(a.sin_port); /* publish port, start native client thread */
fd_set rf; FD_ZERO(&rf); FD_SET(ls, &rf);
struct timeval tv = { 10, 0 }; /* test deadline, not a library requirement */
if (select(0, &rf, NULL, NULL, &tv) != 1) goto fail;
SOCKET accepted = accept(ls, NULL, NULL);
if (accepted == INVALID_SOCKET || (UINT_PTR)accepted > INT_MAX) goto fail;
closesocket(ls); ls = INVALID_SOCKET;
freerdp_peer* p = freerdp_peer_new((int)accepted);
/* If p == NULL, caller still closes accepted; otherwise peer owns it. */
```

## 纯内存自签名 PEM

公有导入 API 是 `freerdp_certificate_new_from_pem(const char*)` 和 `freerdp_key_new_from_pem(const char*)`。[S6] 官方 makecert 库包含 RSA 生成、X509 签名和 memory BIO→PEM 的实现，可作为下面轮廓的出处；这里直接使用已链接的 libcrypto，不调用其文件输出/CLI 流程。[S7]

不要把 `core/test/TestFuzzServerCerts.h` 当作一对可直接粘贴的内存 PEM：它调用 makecert 生成文件；`TestSettings.c` 的解析测试也不能替代一对已匹配的服务端证书/私钥。[S8]

```c
#include <stdlib.h>
#include <string.h>
#include <openssl/evp.h>
#include <openssl/rsa.h>
#include <openssl/pem.h>
#include <openssl/x509v3.h>

static char* bio_text(BIO* b)
{
    char* src = NULL;
    long n = BIO_get_mem_data(b, &src);
    if (n <= 0) return NULL;
    char* dst = malloc((size_t)n + 1);
    if (dst) { memcpy(dst, src, (size_t)n); dst[n] = '\0'; }
    return dst;
}
static int cert_ext(X509* x, int nid, const char* value)
{
    X509V3_CTX ctx;
    X509V3_set_ctx(&ctx, x, x, NULL, NULL, 0);
    X509V3_set_ctx_nodb(&ctx);
    X509_EXTENSION* ext = X509V3_EXT_conf_nid(NULL, &ctx, nid, value);
    if (!ext) return 0;
    int ok = X509_add_ext(x, ext, -1);
    X509_EXTENSION_free(ext);
    return ok;
}
static int fixture_pem(char** cert_pem, char** key_pem)
{
    int ok = 0;
    EVP_PKEY* key = NULL;
    EVP_PKEY_CTX* gen = EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, NULL);
    X509* x = X509_new();
    BIO* cb = BIO_new(BIO_s_mem());
    BIO* kb = BIO_new(BIO_s_mem());
    *cert_pem = NULL; *key_pem = NULL;
#define REQUIRE(v) do { if (!(v)) goto done; } while (0)
    REQUIRE(gen && x && cb && kb);
    REQUIRE(EVP_PKEY_keygen_init(gen) == 1);
    REQUIRE(EVP_PKEY_CTX_set_rsa_keygen_bits(gen, 2048) == 1);
    REQUIRE(EVP_PKEY_keygen(gen, &key) == 1);
    REQUIRE(X509_set_version(x, 2) == 1);
    REQUIRE(ASN1_INTEGER_set(X509_get_serialNumber(x), 1) == 1);
    REQUIRE(X509_gmtime_adj(X509_getm_notBefore(x), -60));
    REQUIRE(X509_gmtime_adj(X509_getm_notAfter(x), 24 * 60 * 60));
    REQUIRE(X509_set_pubkey(x, key) == 1);
    X509_NAME* name = X509_get_subject_name(x);
    REQUIRE(name);
    REQUIRE(X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
                                      (const unsigned char*)"localhost", -1, -1, 0) == 1);
    REQUIRE(X509_set_issuer_name(x, name) == 1);
    REQUIRE(cert_ext(x, NID_basic_constraints, "critical,CA:FALSE"));
    REQUIRE(cert_ext(x, NID_key_usage, "critical,digitalSignature,keyEncipherment"));
    REQUIRE(cert_ext(x, NID_ext_key_usage, "serverAuth"));
    REQUIRE(cert_ext(x, NID_subject_alt_name, "DNS:localhost,IP:127.0.0.1"));
    REQUIRE(X509_sign(x, key, EVP_sha256()) > 0);
    REQUIRE(PEM_write_bio_X509(cb, x) == 1);
    REQUIRE(PEM_write_bio_PrivateKey(kb, key, NULL, NULL, 0, NULL, NULL) == 1);
    *cert_pem = bio_text(cb); *key_pem = bio_text(kb);
    ok = (*cert_pem && *key_pem);
done:
    if (!ok) {
        free(*cert_pem); free(*key_pem);
        *cert_pem = NULL; *key_pem = NULL;
    }
    BIO_free(cb); BIO_free(kb); X509_free(x);
    EVP_PKEY_free(key); EVP_PKEY_CTX_free(gen);
    return ok;
#undef REQUIRE
}
```

证书有效期与密钥长度是夹具选择。使用与已编译 FreeRDP 相同的 OpenSSL/CRT 配置；上述 helper 直接调用 libcrypto，因此其测试 target 也要链接 `OpenSSL::Crypto`。尚未验证本机构建的 OpenSSL 编译选项。

## Peer/context、画面、输入、event loop

以下是同一 C translation unit 的主体轮廓（上面的 Windows headers 在最前）。`FX_TRACE`、stop event 和 peer/context 由 harness 持有，worker 退出前不释放；输入记录只在 join 后读取。需要 `<freerdp/freerdp.h>`、`peer.h`、`settings.h`、`input.h`、`update.h`、`crypto/certificate.h`、`crypto/privatekey.h`，以及 `<winpr/synch.h>`、`<winpr/ssl.h>`。

```c
typedef struct { UINT32 kind, flags, code, x, y; } FX_INPUT;
typedef struct {
    BOOL post;
    UINT frames, used;
    BOOL overflow;
    FX_INPUT input[64];
} FX_TRACE;
typedef struct {
    rdpContext base; /* MUST be first */
    HANDLE stop;
    FX_TRACE* trace;
} FX;

static BOOL record_input(rdpInput* in, UINT32 kind, UINT32 flags,
                         UINT32 code, UINT32 x, UINT32 y)
{
    FX_TRACE* t = ((FX*)in->context)->trace;
    if (t->used == 64) { t->overflow = TRUE; return TRUE; }
    t->input[t->used++] = (FX_INPUT){ kind, flags, code, x, y };
    return TRUE;
}
static BOOL key(rdpInput* i, UINT16 f, UINT8 c)
{ return record_input(i, 1, f, c, 0, 0); }
static BOOL unicode_key(rdpInput* i, UINT16 f, UINT16 c)
{ return record_input(i, 2, f, c, 0, 0); }
static BOOL mouse(rdpInput* i, UINT16 f, UINT16 x, UINT16 y)
{ return record_input(i, 3, f, 0, x, y); }
static BOOL sync_input(rdpInput* i, UINT32 f)
{ return record_input(i, 4, f, 0, 0, 0); }
static BOOL post_connect(freerdp_peer* p)
{ ((FX*)p->context)->trace->post = TRUE; return TRUE; }

static BOOL activate(freerdp_peer* p)
{
    BYTE px[64 * 64 * 3];
    for (size_t n = 0; n < sizeof(px); n += 3) {
        px[n] = 0x20; px[n + 1] = 0x80; px[n + 2] = 0xc0; /* BGR */
    }
    BITMAP_DATA b = { 0 };
    b.destRight = 63; b.destBottom = 63; /* inclusive */
    b.width = 64; b.height = 64; b.bitsPerPixel = 24;
    b.bitmapLength = sizeof(px); b.bitmapDataStream = px;
    b.flags = 0; b.compressed = FALSE;
    BITMAP_UPDATE u = { 0 };
    u.number = 1; u.rectangles = &b; u.skipCompression = TRUE;
    if (!p->context->update->BitmapUpdate(p->context, &u)) return FALSE;
    ((FX*)p->context)->trace->frames++;
    return TRUE;
}
static BOOL prepare_peer(freerdp_peer* p, HANDLE stop, FX_TRACE* trace,
                         const char* cert_pem, const char* key_pem)
{
    p->local = FALSE;
    p->ContextSize = sizeof(FX);
    if (!freerdp_peer_context_new(p)) return FALSE;
    FX* f = (FX*)p->context;
    f->stop = stop; f->trace = trace;
    rdpSettings* s = p->context->settings;
    rdpCertificate* cert = freerdp_certificate_new_from_pem(cert_pem);
    rdpPrivateKey* priv = freerdp_key_new_from_pem(key_pem);
    if (!cert || !priv) {
        freerdp_certificate_free(cert); freerdp_key_free(priv); return FALSE;
    }
    if (!freerdp_settings_set_pointer_len(s, FreeRDP_RdpServerCertificate, cert, 1)) {
        freerdp_certificate_free(cert); freerdp_key_free(priv); return FALSE;
    }
    if (!freerdp_settings_set_pointer_len(s, FreeRDP_RdpServerRsaKey, priv, 1)) {
        freerdp_key_free(priv); return FALSE; /* context owns cert */
    }
#define SB(k, v) do { if (!freerdp_settings_set_bool(s, FreeRDP_##k, v)) return FALSE; } while (0)
    SB(TlsSecurity, TRUE); SB(RdpSecurity, FALSE); SB(NlaSecurity, FALSE);
    SB(ExtSecurity, FALSE); SB(RdstlsSecurity, FALSE); SB(AadSecurity, FALSE);
    SB(RemoteFxCodec, FALSE); SB(NSCodec, FALSE); SB(SupportGraphicsPipeline, FALSE);
#undef SB
    if (!freerdp_settings_set_uint32(s, FreeRDP_DesktopWidth, 320) ||
        !freerdp_settings_set_uint32(s, FreeRDP_DesktopHeight, 240) ||
        !freerdp_settings_set_uint32(s, FreeRDP_ColorDepth, 24)) return FALSE;
    p->PostConnect = post_connect; p->Activate = activate;
    rdpInput* in = p->context->input;
    in->KeyboardEvent = key; in->UnicodeKeyboardEvent = unicode_key;
    in->MouseEvent = mouse; in->SynchronizeEvent = sync_input;
    return p->Initialize(p); /* initializes state; TLS still needs pumping */
}
static DWORD WINAPI peer_worker(void* arg)
{
    freerdp_peer* p = arg;
    FX* f = (FX*)p->context;
    for (;;) {
        HANDLE h[32];
        DWORD n = p->GetEventHandles(p, h, 31);
        if (n == 0 || n > 31) return 2;
        h[n] = f->stop;
        DWORD w = WaitForMultipleObjects(n + 1, h, FALSE, 50);
        if (w == WAIT_OBJECT_0 + n) {
            if (p->activated && !p->Close(p)) return 3;
            return 0;
        }
        if (w == WAIT_TIMEOUT) continue;
        if (w >= WAIT_OBJECT_0 + n) return 2;
        if (!p->CheckFileDescriptor(p)) return 1; /* EOF/error; harness classifies */
    }
}
```

关键依据及约束：

- `freerdp_peer_context_new` 创建 server-mode context，注册发送 update 的 server callbacks，并把 socket attach 到 transport、切为非阻塞。`Initialize` 要求已设置服务器证书。[S9]
- PEM 导入后可释放原始两个 PEM 字符串。`FreeRDP_RdpServerCertificate` / `FreeRDP_RdpServerRsaKey` 的 pointer setter **接管对象所有权**，成功后不再自行 free cert/key；context 清理负责释放。[S6][S10]
- `PostConnect` 初次连接只调用一次；`Activate` 会在初次激活及重激活时调用。画面发送放在 `Activate`；不要在 `PostConnect` 内假定已可绘制。[S11]
- `BITMAP_DATA` / `BITMAP_UPDATE` 字段见公有 `update.h`；64×64×3=12288 字节、stride=192，兼顾行对齐和位图长度。序列化同步复制 bitmap payload，发送函数同步 flush，因此该轮廓的栈 buffer 在调用返回后可释放。原始 bitmap 的垂直方向不会改变单色断言。[S12]
- 输入 callbacks 的真实签名分别为 `(rdpInput*, UINT16, UINT8)`、`(rdpInput*, UINT16, UINT16)`、`(rdpInput*, UINT16, UINT16, UINT16)`、`(rdpInput*, UINT32)`。按接收到的 flags 记录，客户端发送侧可用 `freerdp_input_send_keyboard_event[_ex]`、`freerdp_input_send_mouse_event`，再检查实际的 key-up/down、坐标和按钮记录。[S13]
- `GetEventHandles` 返回值是 `DWORD` 个数；`CheckFileDescriptor` 驱动协议状态机，并不只是检查某个 fd。官方 sample 使用相同 wait/pump 结构。[S1][S14]

## 超时、关闭与所有权

正常路径让客户端在实际像素与输入步骤后调用其原生断开 API；worker 的 `CheckFileDescriptor == FALSE` 可以是预期 EOF，须结合客户端预期断开状态及 trace 判定，不直接当作 fixture 失败。主动服务端关闭可通过 stop event 让 worker 调用 `p->Close(p)`。

**只有外层 50ms wait 不足以限制 TLS 卡住。** TLS accept 内部可能进入 `pollAndHandshake`，它无限等待 transport event 或 `freerdp_abort_event(context)`。[S15] supervisor 在测试 deadline 到期后须：

```c
/* p/context must stay alive until worker has exited. */
SetEvent(stop);
BOOL cancelled = freerdp_abort_connect_context(p->context);
DWORD joined = WaitForSingleObject(worker, 2000);
if (joined == WAIT_OBJECT_0) {
    /* Collect exit code and inspect host-owned FX_TRACE. */
    p->Disconnect(p);
    freerdp_peer_context_free(p);
    freerdp_peer_free(p);
    CloseHandle(worker); CloseHandle(stop);
} else {
    /* Report a stuck fixture; retain p/context/trace/events while worker lives. */
}
```

2 秒只是 harness 的退出预算；正常客户端断开后也要 join，再执行同样清理。不要用 `TerminateThread` 代替生命周期管理。`freerdp_abort_connect_context` 可直接作用于 peer context，不要求客户端 `freerdp*` instance。[S16]

`freerdp_peer_new` 成功后 peer 持有 accepted socket；context attach 成功后 `p->sockfd=-1`，socket 转由 transport 持有。释放 context/peer 即会处理 socket，调用方不要再关闭 accepted socket。若 context 创建或 prepare 失败，同样清理已创建的 context/peer；只有 `freerdp_peer_new` 本身失败才仍由调用方关闭 accepted socket。[S9]

## CLIPRDR / DISP：仅保留后续开关

本轮基础夹具不初始化 WTS manager，也不包含这些 channel 的运行实现。要使用官方 `cliprdr_server_context_new` / `disp_server_context_new`，标准 CMake 路线是生成 **`freerdp-server` 库**：

```text
WITH_SERVER=ON  WITH_CHANNELS=ON  WITH_SERVER_CHANNELS=ON
CHANNEL_CLIPRDR=ON  CHANNEL_CLIPRDR_SERVER=ON
CHANNEL_DISP=ON     CHANNEL_DISP_SERVER=ON
CHANNEL_DRDYNVC=ON
WITH_SHADOW=OFF  WITH_PROXY=OFF  WITH_PLATFORM_SERVER=OFF  WITH_SAMPLE=OFF
```

这可保留 server common/channel 库并关闭这些 server 程序 target；无需运行外部服务。`WITH_SERVER=OFF` 下不能假定已得到 server channel aggregate library。channel server 是独立编译的对象并被 `server/common` 聚合；`CHANNEL_DRDYNVC_SERVER` 也有独立实现，但此类 fixture 的 DVC 管理入口在 core WTS manager，不需要把它误当作外部插件进程。[S4][S17]

后续接入的公有入口是 `WTSRegisterWtsApiFunctionTable(FreeRDP_InitWtsApi())`、`WTSOpenServerA((LPSTR)p->context)`、manager event/check；CLIPRDR 使用 `Start`，DISP 等 `DRDYNVC_STATE_READY` 再 `Open`。DISP 的 `ChannelIdAssigned` 仅表示分配 ID，创建确认应看 `WTSVirtualChannelManagerSetDVCCreationCallback`；成功后还需主动 `DisplayControlCaps`。**本次没有验证 channel 收发或端到端 resize。**[S18]

## NLA 非阻塞后续路线

- **Windows native SSPI**：在单独的 NLA 测试用例中改 `NlaSecurity=TRUE`，客户端也强制 NLA，避免 TLS-only fallback 掩盖失败。WinPR 编译 `WITH_NATIVE_SSPI` 时，Windows 默认使用 native SSPI；`WINPR_NATIVE_SSPI=0` 才禁用。native 侧应使用已有可登录测试账号；不能假定一组随意用户名/密码就能被 Windows 接受。它不要求启动 Windows RDP 服务，但本轮没有验证账号策略、CredSSP 或 loopback 认证条件。[S19]
- **隔离的 WinPR/SAM 测试**：在任何 SSPI 初始化前设置 `WINPR_NATIVE_SSPI=0`，固定进程内使用 WinPR SSPI；server 的 `NtlmSamFile` setting 会传入 `SEC_WINPR_NTLM_SETTINGS_V2.samFile`，并作为 inbound credentials 数据；NTLM 实现随后 `SamOpen(context->SamFile, TRUE)`。也可设 `peer->SspiNtlmHashCallback`，源码会把它和 peer 参数送入 NTLM settings，避免 SAM 文件。SAM 格式、域名匹配、该 callback 的具体签名及实际 NLA 握手本轮未继续审计，不把它写成已跑通方案。[S20]
- SSPI 初始化有进程级缓存；不要在同一测试进程已经初始化 native SSPI 后，仅改环境变量就假定可切换后端。若必须两种后端共存于同一次执行，需另查显式 SSPI backend 选择路径；当前最快是本次测试进程启动时固定一种后端。[S19]

## 实施回填

以上通道夹具路径已实现于 `crates/xsh-rdp/native/test_peer.c`，由 `test-peer` Cargo feature 控制。测试配置单独启用 FreeRDP server 聚合库及 cliprdr / disp server 对象；默认产品配置仍只含客户端白名单。

实现中补充了两个需要保留的约束：

- `FreeRDP_InitWtsApi` 必须通过 `<freerdp/channels/channels.h>` 声明。MSVC 下漏声明会把返回的 64 位函数表指针当作 int，导致后续 WTS 调用访问异常。XSH 自有适配目标将隐式函数声明和相关指针类型警告视为编译错误。
- 服务端在 MCS 加入 `drdynvc` 之前只刷新队列，等通道加入和 PostConnect 后才执行一次 DVC 初始化；提前调用自动初始化会消耗其一次性状态，导致 DISP 永远无法就绪。cliprdr 退出时先 Stop 并等待线程，再释放 context。

已通过原生测试：中文 / emoji 文本的双向 CLIPRDR、DISP monitor layout 与实际 320×240 → 640×480 桌面改尺寸、RGBA bitmap、指针形状 / 热点 / 缓存 / 隐藏 / 默认状态。

NLA 测试使用独立测试进程的 `WINPR_NATIVE_SSPI=0` 和 `peer->SspiNtlmHashCallback`；服务端只接受 NLA。正确密码、带域名账号和错误密码均检查实际 NTLM 哈希回调次数与激活状态。它不改变生产客户端使用 Windows 原生 SSPI 的默认行为，也不创建系统账号或启用系统 RDP 服务。

## 精确源码索引

所有链接均固定到上述 commit，而非浮动分支；代码轮廓是据此整理的夹具实现建议，并非仓库已有、已验证的完整测试程序。

[S1]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/peer.h#L40-L58
[S2]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/listener.c#L441-L468
[S3]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/CMakeLists.txt#L93-L158
[S4]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/server/CMakeLists.txt#L18-L47
[S5]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/server/Sample/sfreerdp.c#L1502-L1506
[S6]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/crypto/certificate.h#L39-L50
[S7]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/tools/makecert/makecert.c#L548-L610
[S8]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/test/TestFuzzServerCerts.h#L24-L108
[S9]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/peer.c#L1462-L1615
[S10]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/common/settings.c#L1455-L1485
[S11]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/peer.c#L740-L778
[S12]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/update.c#L301-L339
[S13]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/input.h#L77-L119
[S14]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/server/Sample/sfreerdp.c#L1248-L1279
[S15]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/crypto/tls.c#L1143-L1191
[S16]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/freerdp.c#L328-L335
[S17]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/server/common/CMakeLists.txt#L18-L35
[S18]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/channels/wtsvc.h#L47-L86
[S19]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/libwinpr/sspi/sspi.c#L60-L107
[S20]: https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/credssp_auth.c#L1008-L1021

补充精确入口：[privatekey.h:33–63](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/crypto/privatekey.h#L33-L63)、[makecert RSA:719–781](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/tools/makecert/makecert.c#L719-L781)、[makecert X509:1020–1109](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/tools/makecert/makecert.c#L1020-L1109)、[update.h:52–76](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/include/freerdp/update.h#L52-L76)、[bitmap 同步发送/flush:1663–1693](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/update.c#L1663-L1693)。

构建/可选 channel 依据：[WITH_SERVER 等开关:54–70](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/cmake/ConfigOptions.cmake#L54-L70)、[根目录 server gate:575–577](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/CMakeLists.txt#L575-L577)、[cliprdr server target](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/cliprdr/server/CMakeLists.txt#L18-L23)、[disp server target](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/disp/server/CMakeLists.txt#L18-L25)、[DVC 创建确认:187–218](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/server.c#L187-L218)、[DISP caps:526–543](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/channels/disp/server/disp_main.c#L526-L543)、[SAM inbound credentials:356–376](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/libfreerdp/core/credssp_auth.c#L356-L376)、[NTLM SAM lookup:275–317](https://github.com/FreeRDP/FreeRDP/blob/97eff6ddfbbfaa8e42a126d362686bd001ff8bdc/winpr/libwinpr/sspi/NTLM/ntlm_compute.c#L275-L317)。
