import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "agentic-workspace",
    icon: "public/favicon",
    name: "Agentic Workspace",
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      // Squirrel builds a .nuspec, which rejects the package unless authors is
      // set. Forge infers it from package.json `author`, so keep both present.
      authors: "baoluong0209",
      description: "Local Electron desktop workspace for coordinating AI CLI agents across projects.",
      name: "AgenticWorkspace",
      setupExe: "AgenticWorkspaceSetup.exe",
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({
      options: {
        productName: "Agentic Workspace",
        maintainer: "baoluong0209",
        homepage: "https://github.com/baoluong2900/agent-control-room",
      },
    }),
    new MakerRpm({
      options: {
        productName: "Agentic Workspace",
        homepage: "https://github.com/baoluong2900/agent-control-room",
        license: "MIT",
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
