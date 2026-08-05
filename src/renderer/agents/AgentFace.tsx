import type { AgentCliId } from "@contracts";

/**
 * Per-CLI agent face.
 *
 * Every agent shares one chassis (head, visor, jaw) so the fleet reads as one
 * family, and each CLI gets its own eyes + crest so `codex`, `claude`, `agy`,
 * … stay tellable apart at avatar size. Colour comes from the catalog accent
 * (`AgentCliDescriptor.accent`) with a local fallback so the face still renders
 * before the catalog IPC resolves.
 */

export type AgentFaceSize = "sm" | "md" | "lg";

/** Mirrors `main/agents/catalog.ts` accents so faces are coloured pre-catalog. */
const fallbackAccent: Record<AgentCliId, string> = {
  kiro: "#a78bfa",
  agy: "#7dd3fc",
  grok: "#fdba9b",
  claude: "#fbbf24",
  codex: "#67e8f9",
  gemini: "#60a5fa",
  amazonq: "#c4b5fd",
  aider: "#86efac",
  opencode: "#f472b6",
  cursor: "#93c5fd",
  copilot: "#f0abfc",
  qwen: "#fcd34d",
  ollama: "#a5f3fc",
  shell: "#afa8c7",
  custom: "#d8b4fe",
};

const facePixels: Record<AgentFaceSize, number> = { sm: 26, md: 34, lg: 44 };

export function agentFaceAccent(cliId: AgentCliId, accent?: string): string {
  return accent?.trim() || fallbackAccent[cliId] || fallbackAccent.custom;
}

export function AgentFace({
  accent,
  cliId,
  offline = false,
  size = "md",
  title,
}: {
  accent?: string;
  cliId: AgentCliId;
  /** Dims the visor glow when the CLI is not installed. */
  offline?: boolean;
  size?: AgentFaceSize;
  title?: string;
}) {
  const tint = offline ? "#8f88aa" : agentFaceAccent(cliId, accent);
  const pixels = facePixels[size];

  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={`agent-face agent-face-${size}${offline ? " offline" : ""}`}
      height={pixels}
      role={title ? "img" : undefined}
      style={{ ["--face-accent" as string]: tint }}
      viewBox="0 0 44 44"
      width={pixels}
    >
      {title && <title>{title}</title>}

      {/* Chassis: neck, head shell, top gloss, visor well, jaw. */}
      <rect className="face-neck" x="18" y="32" width="8" height="5" rx="2.4" />
      <rect className="face-shell" x="7" y="7" width="30" height="27" rx="9.5" />
      <rect className="face-gloss" x="10.5" y="9" width="23" height="4.2" rx="2.1" />
      <rect className="face-visor" x="11" y="13.5" width="22" height="11.5" rx="5" />
      <rect className="face-mouth" x="17.5" y="27.5" width="9" height="2.4" rx="1.2" />

      {crestFor(cliId)}
      {eyesFor(cliId)}
    </svg>
  );
}

/** Head-top silhouette: the fastest cue when the face is only 26px wide. */
function crestFor(cliId: AgentCliId) {
  switch (cliId) {
    case "kiro":
    case "amazonq":
    case "custom":
      return (
        <g className="face-crest">
          <rect x="21.2" y="2.8" width="1.6" height="4.6" rx="0.8" />
          <circle cx="22" cy="2.4" r="2.1" />
        </g>
      );
    case "agy":
    case "opencode":
      return (
        <g className="face-crest">
          <rect x="3.4" y="16" width="3" height="8" rx="1.5" />
          <rect x="37.6" y="16" width="3" height="8" rx="1.5" />
        </g>
      );
    case "ollama":
      return (
        <g className="face-crest">
          <rect x="10.5" y="1.5" width="4" height="8.5" rx="2" />
          <rect x="29.5" y="1.5" width="4" height="8.5" rx="2" />
        </g>
      );
    case "claude":
      return (
        <g className="face-crest">
          <path d="M12 6.6a10.6 10.6 0 0 1 20 0" fill="none" strokeWidth="1.8" strokeLinecap="round" />
        </g>
      );
    case "grok":
    case "qwen":
      return (
        <g className="face-crest">
          <path d="M22 1.6 26.4 8h-8.8Z" />
        </g>
      );
    case "gemini":
      return (
        <g className="face-crest">
          <path d="M22 1.8 23.5 5.6 27.3 7.1 23.5 8.6 22 12.4 20.5 8.6 16.7 7.1 20.5 5.6Z" />
        </g>
      );
    default:
      return null;
  }
}

/** Visor contents, drawn inside the 11–33 x 13.5–25 well. */
function eyesFor(cliId: AgentCliId) {
  switch (cliId) {
    case "kiro":
      return (
        <g className="face-eyes">
          <rect x="14.6" y="17" width="5" height="4.6" rx="1.2" />
          <rect x="24.4" y="17" width="5" height="4.6" rx="1.2" />
        </g>
      );
    case "agy":
      return (
        <g className="face-eyes">
          <circle cx="17.4" cy="19.3" r="2.5" />
          <circle cx="26.6" cy="19.3" r="2.5" />
        </g>
      );
    case "claude":
      return (
        <g className="face-eyes" fill="none" strokeWidth="2.1" strokeLinecap="round">
          <path d="M14.8 20.6a3.1 3.1 0 0 1 5.4 0" />
          <path d="M23.8 20.6a3.1 3.1 0 0 1 5.4 0" />
        </g>
      );
    case "codex":
      return (
        <g className="face-eyes">
          <rect x="14" y="18.2" width="16" height="2.6" rx="1.3" />
          <circle cx="30.4" cy="19.5" r="1.1" opacity="0.75" />
        </g>
      );
    case "gemini":
      return (
        <g className="face-eyes">
          <path d="M17.4 16.6 20.2 19.4 17.4 22.2 14.6 19.4Z" />
          <path d="M26.6 16.6 29.4 19.4 26.6 22.2 23.8 19.4Z" />
        </g>
      );
    case "grok":
      return (
        <g className="face-eyes">
          <path d="M14.2 17.4 20 19.2 19.4 21.6 13.8 19.6Z" />
          <path d="M29.8 17.4 24 19.2 24.6 21.6 30.2 19.6Z" />
        </g>
      );
    case "amazonq":
      return (
        <g className="face-eyes">
          <circle cx="17.4" cy="19.3" r="2.4" fill="none" strokeWidth="1.9" />
          <circle cx="26.6" cy="19.3" r="2.4" fill="none" strokeWidth="1.9" />
          <rect x="27" y="21" width="3.6" height="1.7" rx="0.85" transform="rotate(38 27 21)" />
        </g>
      );
    case "aider":
      return (
        <g className="face-eyes">
          <rect x="13.6" y="17.4" width="7.4" height="4.2" rx="2.1" />
          <rect x="23" y="17.4" width="7.4" height="4.2" rx="2.1" />
          <rect x="21.4" y="18.9" width="1.2" height="1.2" rx="0.6" opacity="0.7" />
        </g>
      );
    case "opencode":
      return (
        <g className="face-eyes" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18.6 16.4 15 19.4l3.6 3" />
          <path d="M25.4 16.4 29 19.4l-3.6 3" />
        </g>
      );
    case "cursor":
      return (
        <g className="face-eyes" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 17.2 18.4 19.4 15 21.6" />
          <path d="M24.4 17.2 27.8 19.4 24.4 21.6" />
        </g>
      );
    case "copilot":
      return (
        <g className="face-eyes">
          <circle cx="17.4" cy="19.4" r="3.1" fill="none" strokeWidth="1.7" />
          <circle cx="26.6" cy="19.4" r="3.1" fill="none" strokeWidth="1.7" />
          <circle cx="17.4" cy="19.4" r="1.1" />
          <circle cx="26.6" cy="19.4" r="1.1" />
        </g>
      );
    case "qwen":
      return (
        <g className="face-eyes">
          <path d="M17.4 16.8 20 18.3v2.9l-2.6 1.5-2.6-1.5v-2.9Z" />
          <path d="M26.6 16.8 29.2 18.3v2.9l-2.6 1.5-2.6-1.5v-2.9Z" />
        </g>
      );
    case "ollama":
      return (
        <g className="face-eyes">
          <circle cx="17.4" cy="19.3" r="2.7" />
          <circle cx="26.6" cy="19.3" r="2.7" />
          <circle cx="18.4" cy="18.4" r="0.9" className="face-glint" />
          <circle cx="27.6" cy="18.4" r="0.9" className="face-glint" />
        </g>
      );
    case "shell":
      return (
        <g className="face-eyes">
          <path d="M14.6 16.8 18.2 19.4 14.6 22" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="20.6" y="21" width="8.4" height="2.1" rx="1.05" />
        </g>
      );
    case "custom":
      return (
        <g className="face-eyes">
          <circle cx="17.4" cy="19.4" r="2.4" />
          <rect x="23.6" y="18.3" width="6" height="2.2" rx="1.1" />
        </g>
      );
    default:
      return (
        <g className="face-eyes">
          <circle cx="17.4" cy="19.3" r="2.5" />
          <circle cx="26.6" cy="19.3" r="2.5" />
        </g>
      );
  }
}
