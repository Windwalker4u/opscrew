import { defineConfig, loadEnv } from "vite";
import { checkoutDefine } from "./config/checkout";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return { base: env.VITE_BASE_PATH, define: checkoutDefine(env) };
});
