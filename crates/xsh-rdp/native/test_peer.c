/* Optional test fixture. Production packages do not enable XSH_RDP_TEST_PEER. */
#include <winpr/winsock.h>
#include "xsh_rdp.h"
#include <freerdp/freerdp.h>
#include <freerdp/peer.h>
#include <freerdp/settings.h>
#include <freerdp/input.h>
#include <freerdp/update.h>
#include <freerdp/pointer.h>
#include <freerdp/channels/channels.h>
#include <freerdp/server/cliprdr.h>
#include <freerdp/server/disp.h>
#include <freerdp/crypto/certificate.h>
#include <freerdp/crypto/privatekey.h>
#include <winpr/synch.h>
#include <winpr/sysinfo.h>
#include <winpr/ssl.h>
#include <winpr/string.h>
#include <winpr/user.h>
#include <winpr/ntlm.h>
#include <openssl/evp.h>
#include <openssl/rsa.h>
#include <openssl/pem.h>
#include <openssl/x509v3.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

typedef void (*TestInput)(void*, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
typedef void (*TestClipboard)(void*, const uint8_t*, size_t);
typedef struct { uint32_t post, frames, inputs, auth; } TestTrace;
typedef struct {
    rdpContext base;
    TestTrace* trace;
    TestInput input;
    TestClipboard clipboard;
    void* user;
    uint32_t mode;
    HANDLE vcm;
    CliprdrServerContext* clip;
    DispServerContext* disp;
    UINT32 disp_id;
    int disp_open;
    int announced;
    CRITICAL_SECTION lock;
    UINT32 pending_width, pending_height;
} TestContext;

static char* bio_text(BIO* bio) {
    char* source = NULL;
    long length = BIO_get_mem_data(bio, &source);
    if (length <= 0) return NULL;
    char* result = malloc((size_t)length + 1);
    if (result) {
        memcpy(result, source, (size_t)length);
        result[length] = 0;
    }
    return result;
}

static int extension(X509* certificate, int nid, const char* value) {
    X509V3_CTX context;
    X509V3_set_ctx(&context, certificate, certificate, NULL, NULL, 0);
    X509V3_set_ctx_nodb(&context);
    X509_EXTENSION* ext = X509V3_EXT_conf_nid(NULL, &context, nid, value);
    if (!ext) return 0;
    int result = X509_add_ext(certificate, ext, -1);
    X509_EXTENSION_free(ext);
    return result;
}

static int make_pem(char** certificate, char** private_key) {
    int result = 0;
    EVP_PKEY* key = NULL;
    EVP_PKEY_CTX* generator = EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, NULL);
    X509* cert = X509_new();
    BIO* cert_bio = BIO_new(BIO_s_mem());
    BIO* key_bio = BIO_new(BIO_s_mem());
    *certificate = NULL; *private_key = NULL;
#define REQUIRE(v) do { if (!(v)) goto done; } while (0)
    REQUIRE(generator && cert && cert_bio && key_bio);
    REQUIRE(EVP_PKEY_keygen_init(generator) == 1);
    REQUIRE(EVP_PKEY_CTX_set_rsa_keygen_bits(generator, 2048) == 1);
    REQUIRE(EVP_PKEY_keygen(generator, &key) == 1);
    REQUIRE(X509_set_version(cert, 2) == 1);
    REQUIRE(ASN1_INTEGER_set(X509_get_serialNumber(cert), 1) == 1);
    REQUIRE(X509_gmtime_adj(X509_getm_notBefore(cert), -60));
    REQUIRE(X509_gmtime_adj(X509_getm_notAfter(cert), 24 * 60 * 60));
    REQUIRE(X509_set_pubkey(cert, key) == 1);
    X509_NAME* name = X509_get_subject_name(cert);
    REQUIRE(name);
    REQUIRE(X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
        (const unsigned char*)"localhost", -1, -1, 0) == 1);
    REQUIRE(X509_set_issuer_name(cert, name) == 1);
    REQUIRE(extension(cert, NID_basic_constraints, "critical,CA:FALSE"));
    REQUIRE(extension(cert, NID_key_usage, "critical,digitalSignature,keyEncipherment"));
    REQUIRE(extension(cert, NID_ext_key_usage, "serverAuth"));
    REQUIRE(extension(cert, NID_subject_alt_name, "DNS:localhost,IP:127.0.0.1"));
    REQUIRE(X509_sign(cert, key, EVP_sha256()) > 0);
    REQUIRE(PEM_write_bio_X509(cert_bio, cert) == 1);
    REQUIRE(PEM_write_bio_PrivateKey(key_bio, key, NULL, NULL, 0, NULL, NULL) == 1);
    *certificate = bio_text(cert_bio); *private_key = bio_text(key_bio);
    result = *certificate && *private_key;
done:
    if (!result) { free(*certificate); free(*private_key); *certificate = NULL; *private_key = NULL; }
    BIO_free(cert_bio); BIO_free(key_bio); X509_free(cert);
    EVP_PKEY_free(key); EVP_PKEY_CTX_free(generator);
    return result;
#undef REQUIRE
}

static BOOL record(rdpInput* input, UINT32 kind, UINT32 flags, UINT32 code, UINT32 x, UINT32 y) {
    TestContext* context = (TestContext*)input->context;
    context->trace->inputs++;
    context->input(context->user, kind, flags, code, x, y);
    return TRUE;
}
static BOOL key_input(rdpInput* input, UINT16 flags, UINT8 code) {
    TestContext* context = (TestContext*)input->context;
    if ((context->mode & 1) && !(flags & KBD_FLAGS_RELEASE)) {
        rdpPointerUpdate* pointer = context->base.update->pointer;
        if (code == 0x3b || code == 0x3c) {
            POINTER_SYSTEM_UPDATE update = {0};
            update.type = code == 0x3b ? SYSPTR_NULL : SYSPTR_DEFAULT;
            if (!pointer->PointerSystem(&context->base, &update)) return FALSE;
        } else if (code == 0x3d) {
            POINTER_CACHED_UPDATE update = {0};
            if (!pointer->PointerCached(&context->base, &update)) return FALSE;
        }
    }
    return record(input, 1, flags, code, 0, 0);
}
static BOOL unicode_input(rdpInput* input, UINT16 flags, UINT16 code) { return record(input, 2, flags, code, 0, 0); }
static BOOL mouse_input(rdpInput* input, UINT16 flags, UINT16 x, UINT16 y) { return record(input, 3, flags, 0, x, y); }
static BOOL synchronize(rdpInput* input, UINT32 flags) { return record(input, 4, flags, 0, 0, 0); }
static BOOL post_connect(freerdp_peer* peer) {
    TestContext* context = (TestContext*)peer->context;
    context->trace->post++;
    if (context->clip && context->clip->Start(context->clip) != CHANNEL_RC_OK) return FALSE;
    return TRUE;
}
static BOOL activate(freerdp_peer* peer) {
    BYTE pixels[64 * 64 * 3];
    for (size_t offset = 0; offset < sizeof(pixels); offset += 3) {
        pixels[offset] = 0x20; pixels[offset + 1] = 0x80; pixels[offset + 2] = 0xc0;
    }
    BITMAP_DATA bitmap = {0};
    bitmap.destRight = 63; bitmap.destBottom = 63;
    bitmap.width = 64; bitmap.height = 64; bitmap.bitsPerPixel = 24;
    bitmap.bitmapLength = sizeof(pixels); bitmap.bitmapDataStream = pixels;
    BITMAP_UPDATE update = {0};
    update.number = 1; update.rectangles = &bitmap; update.skipCompression = TRUE;
    if (!peer->context->update->BitmapUpdate(peer->context, &update)) return FALSE;
    TestContext* context = (TestContext*)peer->context;
    context->trace->frames++;
    if (context->mode & 1) {
        BYTE xor_mask[16 * 16 * 4];
        BYTE and_mask[16 * 2] = {0};
        for (size_t i = 0; i < sizeof(xor_mask); i += 4) {
            xor_mask[i] = 0x44; xor_mask[i + 1] = 0x88;
            xor_mask[i + 2] = 0xcc; xor_mask[i + 3] = 0xff;
        }
        POINTER_NEW_UPDATE cursor = {0};
        cursor.xorBpp = 32;
        cursor.colorPtrAttr.width = 16; cursor.colorPtrAttr.height = 16;
        cursor.colorPtrAttr.hotSpotX = 3; cursor.colorPtrAttr.hotSpotY = 5;
        cursor.colorPtrAttr.lengthXorMask = sizeof(xor_mask);
        cursor.colorPtrAttr.xorMaskData = xor_mask;
        cursor.colorPtrAttr.lengthAndMask = sizeof(and_mask);
        cursor.colorPtrAttr.andMaskData = and_mask;
        if (!peer->context->update->pointer->PointerNew(peer->context, &cursor)) return FALSE;
    }
    return TRUE;
}

static UINT clip_formats(CliprdrServerContext* clip, const CLIPRDR_FORMAT_LIST* formats) {
    TestContext* context = (TestContext*)clip->custom;
    CLIPRDR_FORMAT_LIST_RESPONSE response = {0};
    response.common.msgType = CB_FORMAT_LIST_RESPONSE;
    response.common.msgFlags = CB_RESPONSE_OK;
    UINT result = clip->ServerFormatListResponse(clip, &response);
    if (result != CHANNEL_RC_OK) return result;
    if (!context->announced) {
        context->announced = 1;
        CLIPRDR_FORMAT format = {0};
        format.formatId = CF_UNICODETEXT;
        CLIPRDR_FORMAT_LIST list = {0};
        list.common.msgType = CB_FORMAT_LIST;
        list.numFormats = 1; list.formats = &format;
        result = clip->ServerFormatList(clip, &list);
        if (result != CHANNEL_RC_OK) return result;
    }
    for (UINT32 index = 0; index < formats->numFormats; index++) {
        if (formats->formats[index].formatId != CF_UNICODETEXT) continue;
        CLIPRDR_FORMAT_DATA_REQUEST request = {0};
        request.common.msgType = CB_FORMAT_DATA_REQUEST;
        request.common.dataLen = 4; request.requestedFormatId = CF_UNICODETEXT;
        return clip->ServerFormatDataRequest(clip, &request);
    }
    return CHANNEL_RC_OK;
}

static UINT clip_request(CliprdrServerContext* clip, const CLIPRDR_FORMAT_DATA_REQUEST* request) {
    const WCHAR text[] = {0x8fdc, 0x7aef, 0xd83e, 0xddea, 13, 10, 'c', 'l', 'i', 'p', 0};
    CLIPRDR_FORMAT_DATA_RESPONSE response = {0};
    response.common.msgType = CB_FORMAT_DATA_RESPONSE;
    response.common.msgFlags = request->requestedFormatId == CF_UNICODETEXT ? CB_RESPONSE_OK : CB_RESPONSE_FAIL;
    response.common.dataLen = response.common.msgFlags == CB_RESPONSE_OK ? sizeof(text) : 0;
    response.requestedFormatData = (const BYTE*)text;
    return clip->ServerFormatDataResponse(clip, &response);
}

static UINT clip_response(CliprdrServerContext* clip, const CLIPRDR_FORMAT_DATA_RESPONSE* response) {
    TestContext* context = (TestContext*)clip->custom;
    if (!(response->common.msgFlags & CB_RESPONSE_OK) || response->common.dataLen < 2 ||
        response->common.dataLen % 2 || response->common.dataLen > 2 * 1024 * 1024)
        return ERROR_INVALID_DATA;
    size_t units = response->common.dataLen / 2;
    WCHAR* wide = malloc(response->common.dataLen);
    if (!wide) return CHANNEL_RC_NO_MEMORY;
    memcpy(wide, response->requestedFormatData, response->common.dataLen);
    size_t bytes = 0;
    char* text = wide[units - 1] == 0 ? ConvertWCharNToUtf8Alloc(wide, units - 1, &bytes) : NULL;
    if (text) context->clipboard(context->user, (const uint8_t*)text, bytes);
    free(text); free(wide);
    return CHANNEL_RC_OK;
}

static UINT monitor_layout(DispServerContext* disp, const DISPLAY_CONTROL_MONITOR_LAYOUT_PDU* pdu) {
    TestContext* context = (TestContext*)disp->custom;
    if (pdu->NumMonitors != 1) return ERROR_INVALID_DATA;
    const DISPLAY_CONTROL_MONITOR_LAYOUT* layout = &pdu->Monitors[0];
    EnterCriticalSection(&context->lock);
    context->pending_width = layout->Width; context->pending_height = layout->Height;
    LeaveCriticalSection(&context->lock);
    context->input(context->user, 6, 0, 0, layout->Width, layout->Height);
    return CHANNEL_RC_OK;
}

static BOOL display_assigned(DispServerContext* disp, UINT32 id) {
    ((TestContext*)disp->custom)->disp_id = id;
    return TRUE;
}

static BOOL display_created(void* user, UINT32 id, INT32 status) {
    TestContext* context = (TestContext*)user;
    if (context->disp && id == context->disp_id)
        return status >= 0 && context->disp->DisplayControlCaps(context->disp) == CHANNEL_RC_OK;
    return TRUE;
}

static SECURITY_STATUS fixture_ntlm_hash(void* client,
    const SEC_WINNT_AUTH_IDENTITY* identity, const SecBuffer* proof,
    const BYTE* random, const BYTE* mic, const SecBuffer* mic_value, BYTE* hash) {
    (void)proof; (void)random; (void)mic; (void)mic_value;
    freerdp_peer* peer = (freerdp_peer*)client;
    ((TestContext*)peer->context)->trace->auth++;
    const WCHAR expected[] = {'f', 'i', 'x', 't', 'u', 'r', 'e'};
    if (!(identity->Flags & SEC_WINNT_AUTH_IDENTITY_UNICODE) ||
        identity->UserLength != 7 || memcmp(identity->User, expected, sizeof(expected)))
        return SEC_E_LOGON_DENIED;
    return NTOWFv2W(expected, sizeof(expected), (LPCWSTR)identity->User,
        identity->UserLength * 2, (LPCWSTR)identity->Domain,
        identity->DomainLength * 2, hash) ? SEC_E_OK : SEC_E_INTERNAL_ERROR;
}

XSH_RDP_API int xsh_rdp_test_peer_run(uintptr_t socket, uint32_t mode, TestInput input,
    TestClipboard clipboard, void* user, TestTrace* trace) {
    if (socket > INT_MAX) { closesocket((SOCKET)socket); return -1; }
    freerdp_peer* peer = freerdp_peer_new((int)socket);
    if (!peer) { closesocket((SOCKET)socket); return -1; }
    int result = -1;
    char* cert_pem = NULL;
    char* key_pem = NULL;
    peer->local = FALSE;
    peer->ContextSize = sizeof(TestContext);
    if (!freerdp_peer_context_new(peer)) goto done;
    TestContext* context = (TestContext*)peer->context;
    context->trace = trace; context->input = input; context->user = user;
    context->clipboard = clipboard; context->mode = mode;
    if (!InitializeCriticalSectionAndSpinCount(&context->lock, 4000)) goto done;
    if (mode & 1) {
        if (!WTSRegisterWtsApiFunctionTable(FreeRDP_InitWtsApi())) goto cleanup;
        context->vcm = WTSOpenServerA((LPSTR)peer->context);
        if (!context->vcm || context->vcm == INVALID_HANDLE_VALUE) goto cleanup;
        context->clip = cliprdr_server_context_new(context->vcm);
        context->disp = disp_server_context_new(context->vcm);
        if (!context->clip || !context->disp) goto cleanup;
        context->clip->custom = context; context->clip->rdpcontext = peer->context;
        context->clip->useLongFormatNames = TRUE;
        context->clip->ClientFormatList = clip_formats;
        context->clip->ClientFormatDataRequest = clip_request;
        context->clip->ClientFormatDataResponse = clip_response;
        context->disp->custom = context; context->disp->rdpcontext = peer->context;
        context->disp->MaxNumMonitors = 1;
        context->disp->MaxMonitorAreaFactorA = 4096;
        context->disp->MaxMonitorAreaFactorB = 2160;
        context->disp->DispMonitorLayout = monitor_layout;
        context->disp->ChannelIdAssigned = display_assigned;
        WTSVirtualChannelManagerSetDVCCreationCallback(context->vcm, display_created, context);
    }
    if (!winpr_InitializeSSL(WINPR_SSL_INIT_DEFAULT) || !make_pem(&cert_pem, &key_pem)) goto cleanup;
    rdpSettings* settings = peer->context->settings;
    rdpCertificate* cert = freerdp_certificate_new_from_pem(cert_pem);
    rdpPrivateKey* key = freerdp_key_new_from_pem(key_pem);
    if (!cert || !key) { freerdp_certificate_free(cert); freerdp_key_free(key); goto cleanup; }
    if (!freerdp_settings_set_pointer_len(settings, FreeRDP_RdpServerCertificate, cert, 1)) {
        freerdp_certificate_free(cert); freerdp_key_free(key); goto cleanup;
    }
    if (!freerdp_settings_set_pointer_len(settings, FreeRDP_RdpServerRsaKey, key, 1)) {
        freerdp_key_free(key); goto cleanup;
    }
#define SB(k, v) do { if (!freerdp_settings_set_bool(settings, FreeRDP_##k, v)) goto cleanup; } while (0)
    SB(TlsSecurity, (mode & 2) == 0); SB(RdpSecurity, FALSE); SB(NlaSecurity, (mode & 2) != 0);
    SB(ExtSecurity, FALSE); SB(RdstlsSecurity, FALSE); SB(AadSecurity, FALSE);
    SB(RemoteFxCodec, FALSE); SB(NSCodec, FALSE); SB(SupportGraphicsPipeline, FALSE);
    SB(NetworkAutoDetect, FALSE); SB(SupportHeartbeatPdu, FALSE); SB(SupportMultitransport, FALSE);
#undef SB
    if (!freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, 320) ||
        !freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, 240) ||
        !freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 24)) goto cleanup;
    peer->PostConnect = post_connect;
    peer->Activate = activate;
    if (mode & 2) peer->SspiNtlmHashCallback = fixture_ntlm_hash;
    peer->context->input->KeyboardEvent = key_input;
    peer->context->input->UnicodeKeyboardEvent = unicode_input;
    peer->context->input->MouseEvent = mouse_input;
    peer->context->input->SynchronizeEvent = synchronize;
    if (!peer->Initialize(peer)) goto cleanup;
    ULONGLONG deadline = GetTickCount64() + 15000;
    while (GetTickCount64() < deadline) {
        HANDLE events[MAXIMUM_WAIT_OBJECTS];
        DWORD count = peer->GetEventHandles(peer, events, MAXIMUM_WAIT_OBJECTS - 1);
        if (!count) { result = 0; break; }
        if (context->vcm) events[count++] = WTSVirtualChannelManagerGetEventHandle(context->vcm);
        DWORD status = WaitForMultipleObjects(count, events, FALSE, 20);
        if (status == WAIT_FAILED) break;
        if (!peer->CheckFileDescriptor(peer)) { result = 0; break; }
        if (context->vcm) {
            /* Opening drdynvc before MCS joins it permanently consumes its
               one-shot initialization. Flush queued data during negotiation,
               but start DVC negotiation only after the channel was joined. */
            BOOL joined = WTSVirtualChannelManagerIsChannelJoined(context->vcm, "drdynvc");
            if (!WTSVirtualChannelManagerCheckFileDescriptorEx(context->vcm,
                context->trace->post > 0 && joined)) break;
            if (!context->disp_open &&
                WTSVirtualChannelManagerGetDrdynvcState(context->vcm) == DRDYNVC_STATE_READY) {
                context->disp_open = 1;
                if (context->disp->Open(context->disp) != CHANNEL_RC_OK) break;
            }
            EnterCriticalSection(&context->lock);
            UINT32 width = context->pending_width, height = context->pending_height;
            context->pending_width = 0; context->pending_height = 0;
            LeaveCriticalSection(&context->lock);
            if (width && height) {
                if (!freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, width) ||
                    !freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, height) ||
                    !peer->context->update->DesktopResize(peer->context)) break;
            }
        }
    }
cleanup:
    if (context->clip) {
        context->clip->Stop(context->clip);
        cliprdr_server_context_free(context->clip);
    }
    if (context->disp) disp_server_context_free(context->disp);
    if (context->vcm && context->vcm != INVALID_HANDLE_VALUE) WTSCloseServer(context->vcm);
    DeleteCriticalSection(&context->lock);
done:
    free(cert_pem);
    if (key_pem) { SecureZeroMemory(key_pem, strlen(key_pem)); free(key_pem); }
    freerdp_peer_context_free(peer);
    freerdp_peer_free(peer);
    return result;
}
