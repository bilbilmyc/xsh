// @novnc/novnc ships no TypeScript declarations; this covers the surface the
// remote-desktop pane actually uses.
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrDataChannel: string,
      options?: {
        credentials?: RfbCredentials;
        shared?: boolean;
        repeaterID?: string;
        wsProtocols?: string[];
      },
    );
    scaleViewport: boolean;
    background: string;
    viewOnly: boolean;
    focus(options?: FocusOptions): void;
    blur(): void;
    sendCredentials(credentials: RfbCredentials): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
  }
}
