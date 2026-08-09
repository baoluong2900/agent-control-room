import { AlertTriangle, KeyRound, MessageSquareCode, RefreshCw, Send, Square } from "lucide-react";
import type { GatewayChatCompletion, GatewayChatTarget } from "@contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceNavKey } from "../workspace-navigation";
import {
  describeChatError,
  describeCompletion,
  describeTarget,
  isActive,
  sendBlockedReason,
  type ChatPanelCopy,
  type ChatPhase,
} from "./gateway-chat-ui";
import "./gateway.css";

/**
 * Sends a prompt through a configured OpenAI-compatible gateway and streams the reply.
 *
 * This is the second transport in the app: every other surface spawns a CLI, and this
 * one talks HTTP. The difference the UI has to expose is cancellation — a CLI run is
 * stopped by signalling a process, while a stream is stopped by an id the renderer
 * mints *before* sending, so Stop works during the wait before the first token.
 *
 * Text arrives over `events.subscribeGatewayChat` rather than from the promise, so the
 * answer appears as it is generated instead of all at once at the end.
 */

/** Kept small: this panel is a check-the-gateway tool, not a chat client. */
const MAX_TOKENS = 1024;

type GatewayChatPanelProps = {
  onNavigate?: (nav: WorkspaceNavKey) => void;
};

export function GatewayChatPanel({ onNavigate }: GatewayChatPanelProps) {
  const [targets, setTargets] = useState<GatewayChatTarget[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [problem, setProblem] = useState<ChatPanelCopy | null>(null);
  const [completion, setCompletion] = useState<GatewayChatCompletion | null>(null);

  /** Discards state updates from a request that resolves after unmount. */
  const mountedRef = useRef(true);
  /** Id of the live request, so Stop can name it. */
  const requestIdRef = useRef<string | null>(null);

  const loadTargets = useCallback(async () => {
    // Optional-chained: the verification harnesses build the renderer without the
    // full preload surface, and a missing bridge should render as "unavailable".
    const bridge = window.agentic?.gateway;
    if (!bridge?.listChatTargets) {
      if (mountedRef.current) {
        setProblem({ title: "Unavailable", detail: "The gateway chat bridge is not available in this build." });
      }
      return;
    }
    try {
      const next = await bridge.listChatTargets();
      if (!mountedRef.current) return;
      setTargets(next);
      // Only auto-select while nothing is chosen, so a reload does not move the
      // user's pick out from under them.
      setConnectionId((current) => current || next[0]?.connectionId || "");
    } catch (error) {
      if (!mountedRef.current) return;
      setProblem({
        title: "Unavailable",
        detail: error instanceof Error ? error.message : "Gateway connections could not be listed.",
        action: "retry",
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  // Subscribed once for the panel's lifetime rather than per request: a listener
  // attached at send time would miss deltas that arrive before it is installed.
  useEffect(() => {
    const subscribe = window.agentic?.events?.subscribeGatewayChat;
    if (!subscribe) return;

    return subscribe((event) => {
      // Events carry an id because several requests can be in flight app-wide; this
      // panel only renders its own.
      if (event.requestId !== requestIdRef.current) return;

      if (event.type === "gateway:chat-delta" && event.delta) {
        setPhase("streaming");
        setReply((current) => current + event.delta);
        return;
      }
      if (event.type === "gateway:chat-done" && event.completion) {
        setCompletion(event.completion);
        setPhase(event.completion.cancelled ? "cancelled" : "done");
        return;
      }
      if (event.type === "gateway:chat-error" && event.error) {
        setProblem(describeChatError(event.error));
        setPhase(event.error.kind === "cancelled" ? "cancelled" : "error");
      }
    });
  }, []);

  const blocked = useMemo(() => sendBlockedReason({ prompt, phase, targets }), [prompt, phase, targets]);

  const send = async () => {
    const bridge = window.agentic?.gateway;
    if (!bridge?.sendChat || blocked) return;

    // Minted here, before the request leaves, so Stop has a handle during the wait
    // before the first byte arrives.
    const requestId = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    requestIdRef.current = requestId;

    setReply("");
    setCompletion(null);
    setProblem(null);
    setPhase("sending");

    const result = await bridge.sendChat({
      requestId,
      connectionId: connectionId || undefined,
      model: model.trim() || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt.trim() }],
      maxTokens: MAX_TOKENS,
      stream: true,
    });

    if (!mountedRef.current || requestIdRef.current !== requestId) return;

    // The promise and the terminal event carry the same payload; whichever lands
    // first settles the panel, and this branch is what keeps a non-streaming gateway
    // (no deltas at all) from sitting on "sending" forever.
    if (result.ok) {
      setReply(result.data.text);
      setCompletion(result.data);
      setPhase(result.data.cancelled ? "cancelled" : "done");
    } else {
      setProblem(describeChatError(result.error));
      setPhase(result.error.kind === "cancelled" ? "cancelled" : "error");
    }
  };

  const cancel = async () => {
    const requestId = requestIdRef.current;
    const bridge = window.agentic?.gateway;
    if (!requestId || !bridge?.cancelChat) return;
    await bridge.cancelChat(requestId);
    // The outcome still arrives through the normal path — the abort resolves the
    // stream into a cancelled completion, which carries the partial text.
  };

  const active = isActive(phase);

  return (
    <section className="gateway-panel">
      <header className="gateway-panel-header">
        <div>
          <span className="gateway-eyebrow">
            <MessageSquareCode size={13} />
            Gateway chat
          </span>
          <h2>Prompt a Gateway</h2>
          <p>
            {targets.length === 0
              ? "No OpenAI-compatible connection is configured yet."
              : `Routing through ${targets.length} connection${targets.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        <button className="gateway-link" onClick={() => void loadTargets()} type="button" disabled={active}>
          <RefreshCw size={12} />
          Reload
        </button>
      </header>

      {problem && (
        <div className={`gateway-banner ${problem.action === "settings" ? "info" : "error"}`}>
          <AlertTriangle size={14} />
          <span>
            <strong>{problem.title}</strong>
            <small>{problem.detail}</small>
          </span>
          {problem.action === "settings" && onNavigate && (
            <button className="gateway-link" onClick={() => onNavigate("Settings")} type="button">
              <KeyRound size={12} />
              Open Settings
            </button>
          )}
          {problem.action === "retry" && (
            <button className="gateway-link" onClick={() => void loadTargets()} type="button">
              <RefreshCw size={12} />
              Retry
            </button>
          )}
        </div>
      )}

      <div className="gateway-chat-controls">
        <label className="gateway-chat-field">
          <span>Connection</span>
          <select
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            disabled={active || targets.length === 0}
          >
            {targets.length === 0 && <option value="">No gateway available</option>}
            {targets.map((target) => (
              <option key={target.connectionId} value={target.connectionId}>
                {describeTarget(target)}
              </option>
            ))}
          </select>
        </label>
        <label className="gateway-chat-field">
          <span>Model</span>
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="gpt-4o-mini"
            disabled={active}
          />
        </label>
      </div>

      <label className="gateway-chat-field">
        <span>Prompt</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask the gateway something to confirm it is serving."
          rows={3}
          disabled={active}
        />
      </label>

      <div className="gateway-chat-actions">
        {active ? (
          <button className="gateway-link" onClick={() => void cancel()} type="button">
            <Square size={12} />
            Stop
          </button>
        ) : (
          <button className="gateway-link" onClick={() => void send()} type="button" disabled={Boolean(blocked)}>
            <Send size={12} />
            Send
          </button>
        )}
        {/* The reason is shown rather than left implicit, so a disabled button is
            never a dead end the user has to guess at. */}
        {blocked && !active && <small className="gateway-chat-hint">{blocked}</small>}
        {phase === "sending" && <small className="gateway-chat-hint">Waiting for the first token…</small>}
        {phase === "streaming" && <small className="gateway-chat-hint">Streaming…</small>}
      </div>

      {reply && (
        <div className="gateway-chat-reply">
          <pre>{reply}</pre>
          {/* Partial text is kept on screen after a stop: those tokens were
              generated and billed, so discarding them would lose real work. */}
          {phase === "cancelled" && !completion && (
            <small className="gateway-chat-hint">Stopped — the text above is what arrived first.</small>
          )}
        </div>
      )}

      {completion && <small className="gateway-chat-hint">{describeCompletion(completion)}</small>}
    </section>
  );
}
