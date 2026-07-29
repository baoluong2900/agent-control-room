import type { AgenticDesktopApi } from "@contracts";

declare global {
  interface Window {
    agentic: AgenticDesktopApi;
  }
}

export {};

