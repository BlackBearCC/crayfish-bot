import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";

const PETCLAW_STATE_DIR = path.join(os.homedir(), ".petclaw");

/**
 * 检测是否已由 Pet-Claw 客户端管理配置。
 * ~/.petclaw/character-token 存在即视为已初始化。
 */
function isPetManaged(): boolean {
  const tokenFile = path.join(PETCLAW_STATE_DIR, "character-token");
  return fs.existsSync(tokenFile);
}

export function assertNotPetManaged(runtime: RuntimeEnv): void {
  if (isPetManaged()) {
    runtime.error("当前环境已由 Pet-Claw 客户端管理，请通过 Pet-Claw 客户端管理配置。");
    runtime.exit(1);
  }
}
