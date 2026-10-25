#ifndef XSH_RDP_H
#define XSH_RDP_H
#include <stdint.h>
#include <stddef.h>
#ifdef _WIN32
#ifdef XSH_RDP_EXPORTS
#define XSH_RDP_API __declspec(dllexport)
#else
#define XSH_RDP_API __declspec(dllimport)
#endif
#else
#define XSH_RDP_API __attribute__((visibility("default")))
#endif

typedef struct XshRdp XshRdp;
XSH_RDP_API int xsh_rdp_global_init(void);
typedef struct {
    const char* host;
    const char* server_name;
    const char* config_dir;
    const char* username;
    const char* domain;
    const char* password;
    uint32_t port;
    uint32_t width;
    uint32_t height;
} XshRdpConfig;

typedef struct {
    void (*frame)(void*, uint32_t, uint32_t, uint32_t, uint32_t,
                  uint32_t, uint32_t, const uint8_t*, uint32_t);
    int (*certificate)(void*, const char*, uint32_t, const char*, const char*,
                       const char*, const char*, uint32_t);
    void (*clipboard)(void*, const uint8_t*, size_t);
    /* kind: 0 default, 1 hidden, 2 tightly packed RGBA shape. */
    void (*cursor)(void*, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, const uint8_t*);
    /* flags: 1 clipboard ready, 2 display control ready. */
    void (*capabilities)(void*, uint32_t, uint64_t);
} XshRdpCallbacks;

XSH_RDP_API XshRdp* xsh_rdp_new(const XshRdpConfig*, const XshRdpCallbacks*, void*);
XSH_RDP_API int xsh_rdp_connect(XshRdp*);
XSH_RDP_API int xsh_rdp_step(XshRdp*, uint32_t);
/* The only operation callable concurrently with the owning engine thread. */
XSH_RDP_API void xsh_rdp_abort(XshRdp*);
XSH_RDP_API void xsh_rdp_disconnect(XshRdp*);
XSH_RDP_API void xsh_rdp_free(XshRdp*);
XSH_RDP_API const char* xsh_rdp_error(XshRdp*);
XSH_RDP_API void xsh_rdp_snapshot(XshRdp*);
XSH_RDP_API int xsh_rdp_key(XshRdp*, uint32_t, int, int);
XSH_RDP_API int xsh_rdp_unicode(XshRdp*, uint16_t, int);
XSH_RDP_API int xsh_rdp_mouse(XshRdp*, uint16_t, uint16_t, uint16_t);
XSH_RDP_API int xsh_rdp_resize(XshRdp*, uint32_t, uint32_t);
XSH_RDP_API int xsh_rdp_clipboard(XshRdp*, const uint8_t*, size_t);
#endif
