import { ArrowUpRight, MessageSquare, Radio, Send } from "lucide-react";
import type { AgentProfile } from "@contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentFace } from "./AgentFace";
import { resolveModuleSeed } from "./agent-modules";
import type { ActivityEntry } from "../stores/agents-store";
import { statusLabel, useAgentsStore } from "../stores/agents-store";
import "./agent-room.css";

/**
 * Shared room where every agent's activity lands as one message thread, and the
 * user can hand a task to a specific agent with `@Name <task>` without leaving
 * the room. Every profile posts into the same feed instead of a private log per
 * profile, which is the piece that was missing: agents had no shared place to
 * be seen "talking" to each other or to the operator.
 */
export function AgentRoom({
  profiles,
  projectPath,
  variant = "full",
}: {
  profiles: AgentProfile[];
  projectPath: string;
  variant?: "full" | "compact";
}) {
  const activity = useAgentsStore((state) => state.activity);
  const runProfile = useAgentsStore((state) => state.runProfile);
  const runtimes = useAgentsStore((state) => state.runtimes);
  const [draft, setDraft] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const roomFeed = useMemo(() => buildRoomFeed(activity, profileById), [activity, profileById]);
  const shown = variant === "compact" ? roomFeed.slice(0, 6) : roomFeed;

  useEffect(() => {
    if (variant !== "full") return;
    const node = feedRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [roomFeed.length, variant]);

  const mentionMatch = draft.match(/@([^\s]*)$/);
  const mentionCandidates = useMemo(() => {
    if (!mentionMatch) return [];
    const needle = mentionMatch[1].toLowerCase();
    return profiles.filter((profile) => profile.name.toLowerCase().startsWith(needle)).slice(0, 5);
  }, [mentionMatch, profiles]);

  async function sendToRoom() {
    const text = draft.trim();
    if (!text || sending) return;
    const mention = text.match(/^@([^\s]+)\s+([\s\S]+)$/);
    const target = mention ? profiles.find((profile) => profile.name.toLowerCase() === mention[1].toLowerCase()) : null;

    if (!target) {
      setDraft("");
      return;
    }

    const cwd = target.cwd || projectPath;
    if (!cwd) return;
    setSending(true);
    try {
      await runProfile(target, { prompt: mention![2], cwd });
      setDraft("");
      setMentionOpen(false);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={`agent-room ${variant === "compact" ? "agent-room-compact" : ""}`}>
      <header className="agent-room-head">
        <div>
          <h2>
            <Radio size={15} />
            Agent Room
          </h2>
          <p>Where every agent's status lands, and where you hand off tasks with @name.</p>
        </div>
        <span className="agent-room-live">
          <i />
          {roomFeed.length} messages
        </span>
      </header>

      <div className="agent-room-feed" ref={feedRef}>
        {shown.length === 0 && (
          <p className="agent-room-empty">
            <MessageSquare size={14} />
            No agent activity yet. Run an agent to see it post here.
          </p>
        )}
        {shown.map((message) => (
          <RoomMessage key={message.id} message={message} />
        ))}
      </div>

      {variant === "full" && (
        <form
          className="agent-room-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendToRoom();
          }}
        >
          <div className="agent-room-input-wrap">
            <input
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setMentionOpen(event.target.value.includes("@"));
              }}
              onFocus={() => setMentionOpen(draft.includes("@"))}
              placeholder="@AgentName do this next… (hands the task straight to that agent)"
            />
            {mentionOpen && mentionCandidates.length > 0 && (
              <ul className="agent-room-mentions">
                {mentionCandidates.map((profile) => (
                  <li key={profile.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(`@${profile.name} `);
                        setMentionOpen(false);
                      }}
                    >
                      <AgentFace accent={profile.accent} cliId={profile.cliId} size="sm" />
                      {profile.name}
                      <small>{statusLabel[runtimes[profile.id]?.status ?? "idle"]}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="submit" disabled={sending || !draft.trim()}>
            <Send size={14} />
            Hand off
          </button>
        </form>
      )}
    </section>
  );
}

type RoomMessage = {
  id: string;
  agentName: string;
  cliId: AgentProfile["cliId"];
  accent: string;
  headline: string;
  detail: string;
  status: ActivityEntry["status"];
  at: string;
  toAgentName?: string;
};

/** Turns the shared activity log into room messages, resolving each entry's real agent name. */
function buildRoomFeed(activity: ActivityEntry[], profileById: Map<string, AgentProfile>): RoomMessage[] {
  return activity.map((entry) => {
    const profile = entry.profileId ? profileById.get(entry.profileId) : undefined;
    const module = resolveModuleSeed({
      cliId: profile?.cliId,
      moduleId: profile?.module,
      tags: profile?.tags,
    });
    return {
      id: entry.id,
      agentName: profile?.name ?? module.name,
      cliId: profile?.cliId ?? "custom",
      accent: profile?.accent ?? "#67e8f9",
      headline: entry.title,
      detail: entry.detail,
      status: entry.status,
      at: entry.at,
    };
  });
}

function RoomMessage({ message }: { message: RoomMessage }) {
  return (
    <article className="agent-room-message">
      <AgentFace accent={message.accent} cliId={message.cliId} size="sm" title={message.agentName} />
      <div className="agent-room-bubble">
        <header>
          <strong>{message.agentName}</strong>
          <span className={`agent-room-status status-${message.status}`}>{message.headline}</span>
          <time>{roomTimeAgo(message.at)}</time>
        </header>
        <p>
          {message.toAgentName && (
            <span className="agent-room-handoff">
              <ArrowUpRight size={11} />
              to {message.toAgentName}
            </span>
          )}
          {message.detail}
        </p>
      </div>
    </article>
  );
}

function roomTimeAgo(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "now";
  const minutes = Math.max(Math.round(diff / 60_000), 0);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
