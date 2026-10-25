#include "xsh_rdp.h"
#include <freerdp/config.h>
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/addin.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/disp.h>
#include <freerdp/client/rdpgfx.h>
#include <freerdp/channels/channels.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/graphics.h>
#include <freerdp/codec/color.h>
#include <freerdp/input.h>
#include <freerdp/error.h>
#include <winpr/synch.h>
#include <winpr/crt.h>
#include <winpr/wlog.h>
#include <winpr/string.h>
#include <winpr/user.h>
#include <stdlib.h>
#include <string.h>

#define XSH_MAX_PIXELS (4096u * 2160u)
#define XSH_MAX_CLIPBOARD (1024u * 1024u)
#define XSH_MAX_CURSOR 384u

typedef struct {
    rdpContext context;
    XshRdp* owner;
    RdpgfxClientContext* gfx;
    DispClientContext* disp;
    CliprdrClientContext* clip;
} XshContext;

struct XshRdp {
    freerdp* instance;
    XshRdpCallbacks callbacks;
    void* user;
    char* clipboard;
    size_t clipboard_len;
    int clipboard_ready;
    int connected;
    CRITICAL_SECTION clipboard_lock;
    uint64_t remote_generation;
    uint64_t requested_generation;
    int remote_request_pending;
    int remote_has_unicode;
    uint32_t desired_width;
    uint32_t desired_height;
    uint64_t max_monitor_area;
    int display_ready;
    uint64_t pointer_serial;
    uint64_t current_pointer_serial;
    uint32_t cursor_kind;
};

typedef struct {
    rdpPointer pointer;
    BYTE* pixels;
    uint64_t serial;
} XshPointer;

static void publish_capabilities(XshRdp* rdp) {
    EnterCriticalSection(&rdp->clipboard_lock);
    if (rdp->callbacks.capabilities)
        rdp->callbacks.capabilities(rdp->user,
            (rdp->clipboard_ready ? 1u : 0u) | (rdp->display_ready ? 2u : 0u),
            rdp->max_monitor_area);
    LeaveCriticalSection(&rdp->clipboard_lock);
}

static BOOL pointer_new(rdpContext* context, rdpPointer* pointer) {
    XshPointer* shape = (XshPointer*)pointer;
    if (!pointer->width || !pointer->height ||
        pointer->width > XSH_MAX_CURSOR || pointer->height > XSH_MAX_CURSOR ||
        pointer->xPos >= pointer->width || pointer->yPos >= pointer->height)
        return FALSE;
    shape->pixels = calloc((size_t)pointer->width * pointer->height, 4);
    if (!shape->pixels) return FALSE;
    if (!freerdp_image_copy_from_pointer_data(shape->pixels, PIXEL_FORMAT_RGBA32,
        0, 0, 0, pointer->width, pointer->height, pointer->xorMaskData,
        pointer->lengthXorMask, pointer->andMaskData, pointer->lengthAndMask,
        pointer->xorBpp, &context->gdi->palette)) {
        free(shape->pixels);
        shape->pixels = NULL;
        return FALSE;
    }
    shape->serial = ++((XshContext*)context)->owner->pointer_serial;
    return TRUE;
}

static void pointer_free(rdpContext* context, rdpPointer* pointer) {
    (void)context;
    free(((XshPointer*)pointer)->pixels);
    ((XshPointer*)pointer)->pixels = NULL;
}

static BOOL pointer_set(rdpContext* context, rdpPointer* pointer) {
    XshRdp* rdp = ((XshContext*)context)->owner;
    uint64_t serial = ((XshPointer*)pointer)->serial;
    if (rdp->cursor_kind == 2 && rdp->current_pointer_serial == serial) return TRUE;
    rdp->cursor_kind = 2; rdp->current_pointer_serial = serial;
    if (rdp->callbacks.cursor)
        rdp->callbacks.cursor(rdp->user, 2, pointer->width, pointer->height,
            pointer->xPos, pointer->yPos, ((XshPointer*)pointer)->pixels);
    return TRUE;
}

static BOOL pointer_hidden(rdpContext* context) {
    XshRdp* rdp = ((XshContext*)context)->owner;
    if (rdp->cursor_kind == 1) return TRUE;
    rdp->cursor_kind = 1;
    if (rdp->callbacks.cursor) rdp->callbacks.cursor(rdp->user, 1, 0, 0, 0, 0, NULL);
    return TRUE;
}

static BOOL pointer_default(rdpContext* context) {
    XshRdp* rdp = ((XshContext*)context)->owner;
    if (rdp->cursor_kind == 0) return TRUE;
    rdp->cursor_kind = 0;
    if (rdp->callbacks.cursor) rdp->callbacks.cursor(rdp->user, 0, 0, 0, 0, 0, NULL);
    return TRUE;
}

static BOOL pointer_position(rdpContext* context, UINT32 x, UINT32 y) {
    /* Browsers cannot warp the local OS pointer. Its position follows local input. */
    (void)context; (void)x; (void)y;
    return TRUE;
}

static int valid_size(uint32_t width, uint32_t height) {
    return width >= 200 && height >= 200 && width <= 8192 && height <= 8192 &&
           (uint64_t)width * height <= XSH_MAX_PIXELS;
}

static void publish_frame(rdpContext* context, int full) {
    XshContext* xctx = (XshContext*)context;
    rdpGdi* gdi = context->gdi;
    if (!gdi || !gdi->primary_buffer || !xctx->owner->callbacks.frame) return;
    if (!valid_size((uint32_t)gdi->width, (uint32_t)gdi->height)) return;
    int x = 0, y = 0, w = gdi->width, h = gdi->height;
    if (!full) {
        if (!gdi->primary || !gdi->primary->hdc || !gdi->primary->hdc->hwnd) return;
        HGDI_RGN invalid = gdi->primary->hdc->hwnd->invalid;
        if (!invalid || invalid->null) return;
        x = invalid->x; y = invalid->y; w = invalid->w; h = invalid->h;
        if (x < 0 || y < 0 || w <= 0 || h <= 0 ||
            (int64_t)x + w > gdi->width || (int64_t)y + h > gdi->height) {
            x = 0; y = 0; w = gdi->width; h = gdi->height;
        }
    }
    xctx->owner->callbacks.frame(xctx->owner->user, gdi->width, gdi->height,
        x, y, w, h, gdi->primary_buffer, gdi->stride);
}

static BOOL begin_paint(rdpContext* context) {
    rdpGdi* gdi = context->gdi;
    if (gdi && gdi->primary && gdi->primary->hdc && gdi->primary->hdc->hwnd &&
        gdi->primary->hdc->hwnd->invalid)
        gdi->primary->hdc->hwnd->invalid->null = TRUE;
    return TRUE;
}

static BOOL end_paint(rdpContext* context) {
    publish_frame(context, 0);
    return TRUE;
}

static BOOL desktop_resize(rdpContext* context) {
    uint32_t w = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    uint32_t h = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    if (!valid_size(w, h)) return FALSE;
    if (!gdi_resize(context->gdi, w, h)) return FALSE;
    publish_frame(context, 1);
    return TRUE;
}

static void channel_connected(void* context, const ChannelConnectedEventArgs* e);
static void channel_disconnected(void* context, const ChannelDisconnectedEventArgs* e);

int xsh_rdp_global_init(void) {
    if (freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0) != 0)
        return 0;
    WLog_SetLogLevel(WLog_GetRoot(), WLOG_WARN);
    return 1;
}

static BOOL load_channels(freerdp* instance) {
    /* All configured channels must be compiled in. Never fall back to a
       separately installed channel plugin or helper. */
    const char* names[] = { "cliprdr", "drdynvc", "disp", "rdpgfx" };
    for (size_t index = 0; index < 4; index++) {
        DWORD flags = index < 2
            ? FREERDP_ADDIN_CHANNEL_STATIC | FREERDP_ADDIN_CHANNEL_ENTRYEX
            : FREERDP_ADDIN_CHANNEL_DYNAMIC;
        if (!freerdp_channels_load_static_addin_entry(names[index], NULL, NULL, flags))
            return FALSE;
    }
    return freerdp_client_load_channels(instance);
}

static BOOL pre_connect(freerdp* instance) {
    rdpContext* context = instance->context;
    if (PubSub_SubscribeChannelConnected(context->pubSub, channel_connected) < 0 ||
        PubSub_SubscribeChannelDisconnected(context->pubSub, channel_disconnected) < 0)
        return FALSE;
    return TRUE;
}

static BOOL post_connect(freerdp* instance) {
    rdpContext* context = instance->context;
    XshContext* xctx = (XshContext*)context;
    uint32_t w = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    uint32_t h = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    if (!valid_size(w, h) || !gdi_init(instance, PIXEL_FORMAT_RGBA32)) return FALSE;
    rdpPointer pointer = {0};
    pointer.size = sizeof(XshPointer);
    pointer.New = pointer_new;
    pointer.Free = pointer_free;
    pointer.Set = pointer_set;
    pointer.SetNull = pointer_hidden;
    pointer.SetDefault = pointer_default;
    pointer.SetPosition = pointer_position;
    graphics_register_pointer(context->graphics, &pointer);
    context->update->BeginPaint = begin_paint;
    context->update->EndPaint = end_paint;
    context->update->DesktopResize = desktop_resize;
    if (xctx->gfx && !gdi_graphics_pipeline_init(context->gdi, xctx->gfx)) return FALSE;
    return TRUE;
}

static void post_disconnect(freerdp* instance) {
    rdpContext* context = instance->context;
    if (!context) return;
    PubSub_UnsubscribeChannelConnected(context->pubSub, channel_connected);
    PubSub_UnsubscribeChannelDisconnected(context->pubSub, channel_disconnected);
    if (context->gdi) gdi_free(instance);
}

static DWORD verify_certificate(freerdp* instance, const char* host, UINT16 port,
    const char* common_name, const char* subject, const char* issuer,
    const char* fingerprint, DWORD flags) {
    XshRdp* rdp = ((XshContext*)instance->context)->owner;
    (void)common_name;
    if (!rdp->callbacks.certificate) return 0;
    /* Only trust this connection; XSH owns certificate decisions. */
    return rdp->callbacks.certificate(rdp->user, host, port, subject, issuer,
        fingerprint, "", flags) ? 2 : 0;
}

static DWORD verify_changed_certificate(freerdp* instance, const char* host, UINT16 port,
    const char* common_name, const char* subject, const char* issuer,
    const char* fingerprint, const char* old_subject, const char* old_issuer,
    const char* old_fingerprint, DWORD flags) {
    XshRdp* rdp = ((XshContext*)instance->context)->owner;
    (void)common_name; (void)old_subject; (void)old_issuer;
    if (!rdp->callbacks.certificate) return 0;
    return rdp->callbacks.certificate(rdp->user, host, port, subject, issuer,
        fingerprint, old_fingerprint, flags) ? 2 : 0;
}

static UINT announce_clipboard(CliprdrClientContext* clip) {
    XshRdp* rdp = (XshRdp*)clip->custom;
    CLIPRDR_FORMAT format = {0};
    format.formatId = CF_UNICODETEXT;
    CLIPRDR_FORMAT_LIST list = {0};
    list.common.msgType = CB_FORMAT_LIST;
    EnterCriticalSection(&rdp->clipboard_lock);
    list.numFormats = rdp->clipboard ? 1 : 0;
    LeaveCriticalSection(&rdp->clipboard_lock);
    list.formats = list.numFormats ? &format : NULL;
    return clip->ClientFormatList(clip, &list);
}

static UINT clip_ready(CliprdrClientContext* clip, const CLIPRDR_MONITOR_READY* ready) {
    (void)ready;
    XshRdp* rdp = (XshRdp*)clip->custom;
    CLIPRDR_GENERAL_CAPABILITY_SET general = {0};
    general.capabilitySetType = CB_CAPSTYPE_GENERAL;
    general.capabilitySetLength = CB_CAPSTYPE_GENERAL_LEN;
    general.version = CB_CAPS_VERSION_2;
    general.generalFlags = CB_USE_LONG_FORMAT_NAMES;
    CLIPRDR_CAPABILITIES caps = {0};
    caps.common.msgType = CB_CLIP_CAPS;
    caps.cCapabilitiesSets = 1;
    caps.capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general;
    UINT result = clip->ClientCapabilities(clip, &caps);
    if (result != CHANNEL_RC_OK) return result;
    EnterCriticalSection(&rdp->clipboard_lock);
    rdp->clipboard_ready = 1;
    LeaveCriticalSection(&rdp->clipboard_lock);
    publish_capabilities(rdp);
    return announce_clipboard(clip);
}

static UINT clip_caps(CliprdrClientContext* clip, const CLIPRDR_CAPABILITIES* caps) {
    (void)clip; (void)caps;
    return CHANNEL_RC_OK;
}

static UINT request_remote_clipboard(CliprdrClientContext* clip) {
    XshRdp* rdp = (XshRdp*)clip->custom;
    EnterCriticalSection(&rdp->clipboard_lock);
    if (rdp->remote_request_pending || !rdp->remote_has_unicode) {
        LeaveCriticalSection(&rdp->clipboard_lock);
        return CHANNEL_RC_OK;
    }
    rdp->remote_request_pending = 1;
    rdp->requested_generation = rdp->remote_generation;
    LeaveCriticalSection(&rdp->clipboard_lock);
    CLIPRDR_FORMAT_DATA_REQUEST request = {0};
    request.common.msgType = CB_FORMAT_DATA_REQUEST;
    request.common.dataLen = 4;
    request.requestedFormatId = CF_UNICODETEXT;
    UINT result = clip->ClientFormatDataRequest(clip, &request);
    if (result != CHANNEL_RC_OK) {
        EnterCriticalSection(&rdp->clipboard_lock);
        rdp->remote_request_pending = 0;
        LeaveCriticalSection(&rdp->clipboard_lock);
    }
    return result;
}

static UINT clip_formats(CliprdrClientContext* clip, const CLIPRDR_FORMAT_LIST* formats) {
    XshRdp* rdp = (XshRdp*)clip->custom;
    int has_unicode = 0;
    for (UINT32 index = 0; index < formats->numFormats; index++)
        if (formats->formats[index].formatId == CF_UNICODETEXT) has_unicode = 1;
    EnterCriticalSection(&rdp->clipboard_lock);
    rdp->remote_generation++;
    rdp->remote_has_unicode = has_unicode;
    LeaveCriticalSection(&rdp->clipboard_lock);
    CLIPRDR_FORMAT_LIST_RESPONSE response = {0};
    response.common.msgType = CB_FORMAT_LIST_RESPONSE;
    response.common.msgFlags = CB_RESPONSE_OK;
    UINT result = clip->ClientFormatListResponse(clip, &response);
    if (result != CHANNEL_RC_OK) return result;
    return request_remote_clipboard(clip);
}

static UINT clip_list_response(CliprdrClientContext* clip, const CLIPRDR_FORMAT_LIST_RESPONSE* response) {
    (void)clip; (void)response;
    return CHANNEL_RC_OK;
}

static UINT clip_data_request(CliprdrClientContext* clip, const CLIPRDR_FORMAT_DATA_REQUEST* request) {
    XshRdp* rdp = (XshRdp*)clip->custom;
    WCHAR* wide = NULL;
    size_t units = 0;
    if (request->requestedFormatId == CF_UNICODETEXT) {
        EnterCriticalSection(&rdp->clipboard_lock);
        wide = ConvertUtf8NToWCharAlloc(rdp->clipboard ? rdp->clipboard : "",
            rdp->clipboard ? rdp->clipboard_len : 0, &units);
        LeaveCriticalSection(&rdp->clipboard_lock);
    }
    CLIPRDR_FORMAT_DATA_RESPONSE response = {0};
    response.common.msgType = CB_FORMAT_DATA_RESPONSE;
    response.common.msgFlags = wide ? CB_RESPONSE_OK : CB_RESPONSE_FAIL;
    response.common.dataLen = wide ? (UINT32)((units + 1) * sizeof(WCHAR)) : 0;
    response.requestedFormatData = (const BYTE*)wide;
    UINT result = clip->ClientFormatDataResponse(clip, &response);
    free(wide);
    return result;
}

static UINT clip_data_response(CliprdrClientContext* clip, const CLIPRDR_FORMAT_DATA_RESPONSE* response) {
    XshRdp* rdp = (XshRdp*)clip->custom;
    EnterCriticalSection(&rdp->clipboard_lock);
    int pending = rdp->remote_request_pending;
    int current = rdp->requested_generation == rdp->remote_generation;
    rdp->remote_request_pending = 0;
    LeaveCriticalSection(&rdp->clipboard_lock);
    if (pending && current && (response->common.msgFlags & CB_RESPONSE_OK) &&
        response->common.dataLen >= 2 && response->common.dataLen <= XSH_MAX_CLIPBOARD * 2 &&
        response->common.dataLen % 2 == 0 && response->requestedFormatData) {
        size_t count = response->common.dataLen / 2;
        WCHAR* wide = malloc(response->common.dataLen);
        if (!wide) return CHANNEL_RC_NO_MEMORY;
        memcpy(wide, response->requestedFormatData, response->common.dataLen);
        if (wide[count - 1] == 0) {
            size_t length = 0;
            while (length < count && wide[length] != 0) length++;
            size_t bytes = 0;
            char* text = ConvertWCharNToUtf8Alloc(wide, length, &bytes);
            if (text && bytes <= XSH_MAX_CLIPBOARD && rdp->callbacks.clipboard)
                rdp->callbacks.clipboard(rdp->user, (const uint8_t*)text, bytes);
            free(text);
        }
        free(wide);
    }
    return pending && !current ? request_remote_clipboard(clip) : CHANNEL_RC_OK;
}

static UINT display_caps(DispClientContext* disp, UINT32 monitors, UINT32 factor_a, UINT32 factor_b) {
    XshRdp* rdp = (XshRdp*)disp->custom;
    EnterCriticalSection(&rdp->clipboard_lock);
    rdp->max_monitor_area = (uint64_t)factor_a * factor_b;
    rdp->display_ready = monitors > 0 && rdp->max_monitor_area >= 200u * 200u;
    uint32_t width = rdp->desired_width, height = rdp->desired_height;
    LeaveCriticalSection(&rdp->clipboard_lock);
    publish_capabilities(rdp);
    if (width && height) xsh_rdp_resize(rdp, width, height);
    return CHANNEL_RC_OK;
}

static void channel_connected(void* context, const ChannelConnectedEventArgs* e) {
    XshContext* xctx = (XshContext*)context;
    if (!strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME)) {
        xctx->gfx = (RdpgfxClientContext*)e->pInterface;
        if (xctx->context.gdi) gdi_graphics_pipeline_init(xctx->context.gdi, xctx->gfx);
    } else if (!strcmp(e->name, DISP_DVC_CHANNEL_NAME)) {
        xctx->disp = (DispClientContext*)e->pInterface;
        xctx->disp->custom = xctx->owner;
        xctx->disp->DisplayControlCaps = display_caps;
    } else if (!strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME)) {
        xctx->clip = (CliprdrClientContext*)e->pInterface;
        xctx->clip->custom = xctx->owner;
        xctx->clip->MonitorReady = clip_ready;
        xctx->clip->ServerCapabilities = clip_caps;
        xctx->clip->ServerFormatList = clip_formats;
        xctx->clip->ServerFormatListResponse = clip_list_response;
        xctx->clip->ServerFormatDataRequest = clip_data_request;
        xctx->clip->ServerFormatDataResponse = clip_data_response;
    }
}

static void channel_disconnected(void* context, const ChannelDisconnectedEventArgs* e) {
    XshContext* xctx = (XshContext*)context;
    if (!strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME)) {
        if (xctx->context.gdi && xctx->gfx)
            gdi_graphics_pipeline_uninit(xctx->context.gdi, xctx->gfx);
        xctx->gfx = NULL;
    } else if (!strcmp(e->name, DISP_DVC_CHANNEL_NAME)) {
        EnterCriticalSection(&xctx->owner->clipboard_lock);
        xctx->owner->display_ready = 0;
        xctx->owner->max_monitor_area = 0;
        xctx->disp = NULL;
        LeaveCriticalSection(&xctx->owner->clipboard_lock);
        publish_capabilities(xctx->owner);
    } else if (!strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME)) {
        EnterCriticalSection(&xctx->owner->clipboard_lock);
        xctx->owner->clipboard_ready = 0;
        xctx->owner->remote_request_pending = 0;
        xctx->owner->remote_has_unicode = 0;
        xctx->clip = NULL;
        LeaveCriticalSection(&xctx->owner->clipboard_lock);
        publish_capabilities(xctx->owner);
    }
}

XshRdp* xsh_rdp_new(const XshRdpConfig* config, const XshRdpCallbacks* callbacks, void* user) {
    if (!config || !callbacks || !config->host || !valid_size(config->width, config->height) ||
        config->port == 0 || config->port > 65535) return NULL;
    XshRdp* rdp = calloc(1, sizeof(XshRdp));
    if (!rdp) return NULL;
    if (!InitializeCriticalSectionAndSpinCount(&rdp->clipboard_lock, 4000)) {
        free(rdp); return NULL;
    }
    rdp->callbacks = *callbacks;
    rdp->user = user;
    rdp->instance = freerdp_new();
    if (!rdp->instance) { DeleteCriticalSection(&rdp->clipboard_lock); free(rdp); return NULL; }
    freerdp* instance = rdp->instance;
    instance->ContextSize = sizeof(XshContext);
    if (!freerdp_context_new(instance)) {
        freerdp_free(instance); DeleteCriticalSection(&rdp->clipboard_lock); free(rdp); return NULL;
    }
    ((XshContext*)instance->context)->owner = rdp;
    instance->PreConnect = pre_connect;
    instance->LoadChannels = load_channels;
    instance->PostConnect = post_connect;
    instance->PostDisconnect = post_disconnect;
    instance->VerifyCertificateEx = verify_certificate;
    instance->VerifyChangedCertificateEx = verify_changed_certificate;
    rdpSettings* settings = instance->context->settings;
#define SET_BOOL(key, value) if (!freerdp_settings_set_bool(settings, FreeRDP_##key, value)) goto fail
#define SET_U32(key, value) if (!freerdp_settings_set_uint32(settings, FreeRDP_##key, value)) goto fail
#define SET_STR(key, value) if (!freerdp_settings_set_string(settings, FreeRDP_##key, value)) goto fail
    SET_STR(ServerHostname, config->host);
    SET_STR(CertificateName, config->server_name);
    /* XSH never adopts another FreeRDP application's known_hosts store. */
    SET_STR(ConfigPath, config->config_dir);
    SET_STR(Username, config->username);
    SET_STR(Domain, config->domain);
    SET_STR(Password, config->password);
    SET_U32(ServerPort, config->port);
    SET_U32(DesktopWidth, config->width);
    SET_U32(DesktopHeight, config->height);
    SET_U32(ColorDepth, 32);
    SET_U32(KeyboardLayout, 0x0409);
    SET_U32(TcpConnectTimeout, 10000);
    SET_BOOL(SoftwareGdi, TRUE);
    SET_BOOL(DesktopResize, TRUE);
    SET_BOOL(SupportDisplayControl, TRUE);
    SET_BOOL(DynamicResolutionUpdate, TRUE);
    SET_BOOL(SupportGraphicsPipeline, TRUE);
    SET_BOOL(RedirectClipboard, TRUE);
    SET_BOOL(NlaSecurity, TRUE);
    SET_BOOL(TlsSecurity, TRUE);
    SET_BOOL(RdpSecurity, FALSE);
    SET_BOOL(IgnoreCertificate, FALSE);
    SET_BOOL(AutoAcceptCertificate, FALSE);
    SET_BOOL(AutoDenyCertificate, FALSE);
    SET_BOOL(ExternalCertificateManagement, FALSE);
    SET_BOOL(CertificateCallbackPreferPEM, FALSE);
    SET_BOOL(UseCommonStdioCallbacks, FALSE);
    SET_U32(AuthenticationLevel, 2);
    SET_U32(ClipboardFeatureMask, CLIPRDR_FLAG_LOCAL_TO_REMOTE | CLIPRDR_FLAG_REMOTE_TO_LOCAL);
    SET_BOOL(AutoReconnectionEnabled, FALSE);
    SET_BOOL(AudioPlayback, FALSE);
    SET_BOOL(AudioCapture, FALSE);
    SET_BOOL(RedirectDrives, FALSE);
    SET_BOOL(RedirectPrinters, FALSE);
    SET_BOOL(RedirectSmartCards, FALSE);
    SET_BOOL(DeviceRedirection, FALSE);
    /* These optional RDP8 diagnostics force rdpdr and fake audio channels in
       the common loader. Keep this client on the four bundled channels. */
    SET_BOOL(NetworkAutoDetect, FALSE);
    SET_BOOL(SupportHeartbeatPdu, FALSE);
    SET_BOOL(SupportMultitransport, FALSE);
    return rdp;
fail:
    xsh_rdp_free(rdp);
    return NULL;
}

int xsh_rdp_connect(XshRdp* rdp) {
    if (!rdp || !freerdp_connect(rdp->instance)) return 0;
    rdp->connected = 1;
    publish_capabilities(rdp);
    return 1;
}

int xsh_rdp_step(XshRdp* rdp, uint32_t timeout_ms) {
    HANDLE events[MAXIMUM_WAIT_OBJECTS];
    rdpContext* context = rdp->instance->context;
    if (freerdp_shall_disconnect_context(context)) goto ended;
    DWORD count = freerdp_get_event_handles(context, events, MAXIMUM_WAIT_OBJECTS);
    if (count == 0) goto ended;
    DWORD result = WaitForMultipleObjects(count, events, FALSE, timeout_ms);
    if (result == WAIT_FAILED) return -1;
    if (result == WAIT_TIMEOUT) return 1;
    if (freerdp_check_event_handles(context)) return 1;
ended:
    switch (freerdp_get_last_error(context)) {
        case FREERDP_ERROR_SUCCESS:
        case FREERDP_ERROR_RPC_INITIATED_DISCONNECT:
        case FREERDP_ERROR_RPC_INITIATED_LOGOFF:
        case FREERDP_ERROR_RPC_INITIATED_DISCONNECT_BY_USER:
        case FREERDP_ERROR_LOGOFF_BY_USER:
            return 0;
        default:
            return -1;
    }
}

void xsh_rdp_abort(XshRdp* rdp) {
    if (rdp && rdp->instance && rdp->instance->context)
        freerdp_abort_connect_context(rdp->instance->context);
}

void xsh_rdp_disconnect(XshRdp* rdp) {
    if (rdp && rdp->instance) {
        freerdp_disconnect(rdp->instance);
        rdp->connected = 0;
    }
}

void xsh_rdp_free(XshRdp* rdp) {
    if (!rdp) return;
    if (rdp->instance) {
        if (rdp->connected) xsh_rdp_disconnect(rdp);
        if (rdp->instance->context && rdp->instance->context->settings) {
            char* password = (char*)freerdp_settings_get_string(
                rdp->instance->context->settings, FreeRDP_Password);
            if (password) SecureZeroMemory(password, strlen(password));
        }
        freerdp_context_free(rdp->instance);
        freerdp_free(rdp->instance);
    }
    if (rdp->clipboard) {
        SecureZeroMemory(rdp->clipboard, rdp->clipboard_len);
        free(rdp->clipboard);
    }
    DeleteCriticalSection(&rdp->clipboard_lock);
    free(rdp);
}

const char* xsh_rdp_error(XshRdp* rdp) {
    if (!rdp || !rdp->instance || !rdp->instance->context) return "RDP initialization failed";
    UINT32 code = freerdp_get_last_error(rdp->instance->context);
    return freerdp_get_last_error_string(code);
}

void xsh_rdp_snapshot(XshRdp* rdp) { publish_frame(rdp->instance->context, 1); }

int xsh_rdp_key(XshRdp* rdp, uint32_t scan, int down, int extended) {
    UINT16 flags = (down ? 0 : KBD_FLAGS_RELEASE) | (extended ? KBD_FLAGS_EXTENDED : 0);
    return freerdp_input_send_keyboard_event(rdp->instance->context->input, flags, (UINT8)scan);
}

int xsh_rdp_unicode(XshRdp* rdp, uint16_t code, int down) {
    return freerdp_input_send_unicode_keyboard_event(rdp->instance->context->input,
        down ? 0 : KBD_FLAGS_RELEASE, code);
}

int xsh_rdp_mouse(XshRdp* rdp, uint16_t flags, uint16_t x, uint16_t y) {
    return freerdp_input_send_mouse_event(rdp->instance->context->input, flags, x, y);
}

int xsh_rdp_resize(XshRdp* rdp, uint32_t width, uint32_t height) {
    XshContext* context = (XshContext*)rdp->instance->context;
    if (!valid_size(width, height)) return 0;
    EnterCriticalSection(&rdp->clipboard_lock);
    rdp->desired_width = width; rdp->desired_height = height;
    int ready = rdp->display_ready;
    int fits = (uint64_t)width * height <= rdp->max_monitor_area;
    DispClientContext* disp = context->disp;
    LeaveCriticalSection(&rdp->clipboard_lock);
    if (!ready || !disp) return 2; /* queued until display capabilities arrive */
    if (!fits) return 0;
    DISPLAY_CONTROL_MONITOR_LAYOUT layout = {0};
    layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
    layout.Width = width & ~1u;
    layout.Height = height;
    layout.PhysicalWidth = width * 254 / 960;
    layout.PhysicalHeight = height * 254 / 960;
    layout.Orientation = ORIENTATION_LANDSCAPE;
    layout.DesktopScaleFactor = 100;
    layout.DeviceScaleFactor = 100;
    return disp->SendMonitorLayout(disp, 1, &layout) == 0;
}

int xsh_rdp_clipboard(XshRdp* rdp, const uint8_t* data, size_t len) {
    if (len > XSH_MAX_CLIPBOARD || (len && !data)) return 0;
    char* copy = malloc(len + 1);
    if (!copy) return 0;
    memcpy(copy, data, len);
    copy[len] = 0;
    EnterCriticalSection(&rdp->clipboard_lock);
    char* old = rdp->clipboard;
    size_t old_len = rdp->clipboard_len;
    rdp->clipboard = copy;
    rdp->clipboard_len = len;
    int ready = rdp->clipboard_ready;
    CliprdrClientContext* clip = ((XshContext*)rdp->instance->context)->clip;
    LeaveCriticalSection(&rdp->clipboard_lock);
    if (old) { SecureZeroMemory(old, old_len); free(old); }
    return ready && clip ? announce_clipboard(clip) == CHANNEL_RC_OK : 1;
}
