import { Channel, invoke } from "@tauri-apps/api/core";
import type { AiMode } from "./ai-context";
import type { AiHistoryMessage } from "./ai-conversation";

export type { AiHistoryMessage } from "./ai-conversation";

export interface AiSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface AiSettingsUpdate {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  clearApiKey: boolean;
}

export interface AiCompletionRequest {
  mode: AiMode | "complete";
  prompt: string;
  context: string;
  history?: AiHistoryMessage[];
}

export interface AiStreamEvent {
  requestId: string;
  delta: string;
}

export const aiApi = {
  getSettings: () => invoke<AiSettings>("ai_get_settings"),
  saveSettings: (update: AiSettingsUpdate) => invoke<AiSettings>("ai_save_settings", { update }),
  complete: (request: AiCompletionRequest) => invoke<string>("ai_complete", { request }),
  stream: (request: AiCompletionRequest, requestId: string, onEvent: (event: AiStreamEvent) => void) => {
    const channel = new Channel<AiStreamEvent>();
    channel.onmessage = onEvent;
    return invoke<string>("ai_stream", { request, requestId, onEvent: channel });
  },
  cancel: (requestId: string) => invoke<void>("ai_cancel", { requestId }),
};
