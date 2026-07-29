// Registers the TypeScript loader hook. Use with:
//   node --import ./tests/support/register.mjs --test tests/**/*.test.ts
import { register } from "node:module";

register("./ts-loader.mjs", import.meta.url);
