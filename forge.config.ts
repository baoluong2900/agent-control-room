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
      name: "AgenticWorkspace",
      setupExe: "AgenticWorkspaceSetup.exe",
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({
      options: {
        productName: "Agentic Workspace",
        maintainer: "Agentic Workspace",
        homepage: "https://local.agentic-workspace",
      },
    }),
    new MakerRpm({
      options: {
        productName: "Agentic Workspace",
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "apps/desktop/src/main/main.ts",
          config: "apps/desktop/vite.main.config.ts",
          target: "main",
        },
        {
          entry: "apps/desktop/src/preload/preload.ts",
          config: "apps/desktop/vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "apps/desktop/vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
