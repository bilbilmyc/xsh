import { useCallback, useEffect, useRef, useState } from "react";
import { aiApi } from "../ai-api";
import { limitAiConversation, type AiHistoryMessage, type AiHistoryTurn } from "../ai-conversation";
import { extractCommandDraft, type AiMode } from "../ai-context";
import type { AiTarget } from "./AiAssistantPanel";

type ConversationTarget = Pick<AiTarget, "tabId" | "name" | "connectionVersion" | "connectionId">;

export function sameAiTarget(first: ConversationTarget | null, second: ConversationTarget | null): boolean {
  return first?.tabId === second?.tabId && first?.connectionVersion === second?.connectionVersion && first?.connectionId === second?.connectionId;
}

export interface AiConversationTurn extends AiHistoryTurn {
  id: string;
  contextLabel: string;
  model: string;
  target: ConversationTarget | null;
  error?: string;
}

export interface AiPreparedRequest {
  mode: AiMode;
  prompt: string;
  context: string;
  contextLabel: string;
  target: ConversationTarget | null;
  notice: string;
  model: string;
  baseUrl: string;
  history: AiHistoryMessage[];
  includedTurns: number;
  omittedTurns: number;
  truncatedMessages: number;
}

interface AiDraft {
  turnId: string;
  text: string;
  target: ConversationTarget | null;
}

export interface AiConversationState {
  mode: AiMode;
  prompt: string;
  context: string;
  contextSource: "selection" | "recent-output" | "manual";
  contextTarget: ConversationTarget | null;
  turns: AiConversationTurn[];
  prepared: AiPreparedRequest | null;
  draft: AiDraft | null;
  notice: string;
  error: string | null;
}

const SCRATCH_KEY = "scratch";

function conversationKey(tabId?: string): string {
  return tabId ? `tab:${tabId}` : SCRATCH_KEY;
}

function emptyConversation(): AiConversationState {
  return { mode: "command", prompt: "", context: "", contextSource: "manual", contextTarget: null, turns: [], prepared: null, draft: null, notice: "", error: null };
}

const EMPTY_CONVERSATION = emptyConversation();

export function useAiConversation(target: AiTarget | null, openTabIds: string[]) {
  const [conversations, setConversations] = useState<Record<string, AiConversationState>>({});
  const key = conversationKey(target?.tabId);
  const currentKeyRef = useRef(key);
  const currentTargetRef = useRef(target);
  const activeRef = useRef<{ requestId: string; key: string } | null>(null);
  const liveKeysRef = useRef(new Set<string>());
  currentKeyRef.current = key;
  currentTargetRef.current = target;
  liveKeysRef.current = new Set([SCRATCH_KEY, ...openTabIds.map((tabId) => conversationKey(tabId))]);

  const update = useCallback((owner: string, change: (conversation: AiConversationState) => AiConversationState) => {
    setConversations((previous) => {
      if (!liveKeysRef.current.has(owner)) return previous;
      const next = change(previous[owner] ?? emptyConversation());
      return { ...previous, [owner]: { ...next, turns: limitAiConversation(next.turns) } };
    });
  }, []);

  const stop = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    update(active.key, (previous) => ({ ...previous, prepared: null, turns: previous.turns.map((turn) => turn.id === active.requestId ? { ...turn, status: "stopped" } : turn) }));
    void aiApi.cancel(active.requestId).catch(() => undefined);
  }, [update]);

  const resetAll = useCallback(() => {
    stop();
    setConversations({});
  }, [stop]);

  useEffect(() => {
    if (activeRef.current && activeRef.current.key !== key) stop();
  }, [key, stop]);

  useEffect(() => {
    const liveKeys = new Set(openTabIds.map((tabId) => conversationKey(tabId)));
    liveKeys.add(SCRATCH_KEY);
    if (activeRef.current && !liveKeys.has(activeRef.current.key)) stop();
    setConversations((previous) => {
      const remaining = Object.entries(previous).filter(([owner]) => liveKeys.has(owner));
      return remaining.length === Object.keys(previous).length ? previous : Object.fromEntries(remaining);
    });
  }, [openTabIds, stop]);

  useEffect(() => () => {
    const active = activeRef.current;
    activeRef.current = null;
    if (active) void aiApi.cancel(active.requestId).catch(() => undefined);
  }, []);

  const updateCurrent = (change: (conversation: AiConversationState) => AiConversationState) => update(key, change);

  const startNew = () => {
    stop();
    update(key, () => emptyConversation());
  };

  const submit = async (snapshot: AiPreparedRequest) => {
    if (activeRef.current || conversationKey(snapshot.target?.tabId) !== currentKeyRef.current) return;
    if (!sameAiTarget(snapshot.target, currentTargetRef.current)) {
      update(currentKeyRef.current, (previous) => ({ ...previous, prepared: null, error: "终端连接已变化，请重新检查上下文并预览本次请求。" }));
      return;
    }
    const owner = currentKeyRef.current;
    const requestId = crypto.randomUUID();
    activeRef.current = { requestId, key: owner };
    const isCurrent = () => activeRef.current?.requestId === requestId && currentKeyRef.current === owner;
    const turn: AiConversationTurn = { id: requestId, mode: snapshot.mode, prompt: snapshot.prompt, context: snapshot.context, contextLabel: snapshot.contextLabel, text: "", status: "streaming", model: snapshot.model, target: snapshot.target };
    update(owner, (previous) => ({ ...previous, prompt: "", context: "", contextSource: "manual", contextTarget: null, prepared: null, draft: null, notice: "", error: null, turns: [...previous.turns, turn] }));
    try {
      const text = await aiApi.stream({ mode: snapshot.mode, prompt: snapshot.prompt, context: snapshot.context, history: snapshot.history }, requestId, (event) => {
        if (!isCurrent() || event.requestId !== requestId) return;
        update(owner, (previous) => ({ ...previous, turns: previous.turns.map((item) => item.id === requestId ? { ...item, text: item.text + event.delta } : item) }));
      });
      if (!isCurrent()) return;
      activeRef.current = null;
      const command = snapshot.mode === "command" ? extractCommandDraft(text) : null;
      update(owner, (previous) => ({ ...previous, turns: previous.turns.map((item) => item.id === requestId ? { ...item, text, status: "complete" } : item), draft: command ? { turnId: requestId, text: command, target: snapshot.target } : null }));
    } catch (caught) {
      if (!isCurrent()) return;
      activeRef.current = null;
      update(owner, (previous) => ({ ...previous, draft: null, turns: previous.turns.map((item) => item.id === requestId ? { ...item, status: "error", error: String(caught) } : item) }));
    }
  };

  return {
    conversation: conversations[key] ?? EMPTY_CONVERSATION,
    busy: activeRef.current?.key === key,
    updateCurrent,
    updateForTab: (tabId: string, change: (conversation: AiConversationState) => AiConversationState) => update(conversationKey(tabId), change),
    stop,
    resetAll,
    startNew,
    submit,
  };
}
