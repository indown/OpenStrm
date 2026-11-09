/**
 * 设置页「CloudDrive2」一节的「检查连接和路径」：按页面上当前填的值（还没保存也行）连一次 CD2。
 * 掩码的令牌 / 口令换回库里的原值。三段各自成败：地址通不通、凭据对不对、每个挂载映射在 CD2 里列不列得出来。不回任何令牌。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Cd2CheckResult } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { messageOf } from "../../lib/errors.js";
import { resolveSecret } from "../../lib/secrets.js";
import { parse } from "../../lib/validate.js";
import { Cd2Error, cd2CopyTasks, cd2ListDir, cd2SystemInfo, cd2Token } from "../../services/cd2/client.js";
import { cd2ConnectionOf, cd2MountsOf } from "../../services/cd2/config.js";

const bodySchema = z.object({
  url: z.string().trim().max(300),
  apiToken: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  mounts: z.record(z.string(), z.string()).optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/cd2/check", { preHandler: [fastify.authenticate] }, async (request): Promise<Cd2CheckResult> => {
    const body = parse(bodySchema, request.body ?? {});
    const stored = readAppSettings().cd2;
    const draft = {
      ...body,
      apiToken: resolveSecret(body.apiToken, stored?.apiToken),
      password: resolveSecret(body.password, stored?.password),
    };
    if (!draft.url) return { system: { ok: false, message: "还没填地址" }, auth: { ok: false, message: "还没填地址" }, mounts: [] };
    const probe = { url: draft.url, apiToken: draft.apiToken, username: draft.username, password: draft.password };
    let system: Cd2CheckResult["system"];
    try {
      const info = await cd2SystemInfo(probe);
      system = {
        ok: true,
        loggedIn: info.loggedIn,
        userName: info.userName,
        message: info.loggedIn ? `连上了，CD2 已登录${info.userName ? `（${info.userName}）` : ""}` : "连上了，但 CD2 自己还没登录云盘账号",
      };
    } catch (err) {
      system = { ok: false, message: messageOf(err) };
    }
    const conn = cd2ConnectionOf(draft);
    let auth: Cd2CheckResult["auth"];
    if (!conn) auth = { ok: false, message: "没填 API 令牌，也没填用户名和口令" };
    else if (!system.ok) auth = { ok: false, message: "地址都没通，凭据先不验" };
    else {
      // API 令牌不经 GetToken，光拿到手不算验过：带着它列一次根目录才知道对不对
      try {
        await cd2Token(conn);
        await cd2ListDir(conn, "/");
        auth = { ok: true, message: conn.apiToken ? "API 令牌可用" : "用户名口令换到了令牌" };
      } catch (err) {
        auth = { ok: false, message: messageOf(err) };
      }
    }
    // 复制引擎选 CD2 时还要能看传输任务（GetCopyTasks）；CD2 的 API 令牌是按权限勾的，真机撞到过只勾了读和复制
    let copy: Cd2CheckResult["copy"];
    if (conn && auth.ok) {
      try {
        await cd2CopyTasks(conn);
        copy = { ok: true, message: "能看传输任务，复制进度盯得到" };
      } catch (err) {
        copy = {
          ok: false,
          message: err instanceof Cd2Error && err.code === 7 ? "令牌没有「查看传输任务」权限：复制引擎选 CD2 的话看不到进度，只能按目标目录核对完成" : messageOf(err),
        };
      }
    }
    const mounts: Cd2CheckResult["mounts"] = [];
    for (const [account, path] of Object.entries(cd2MountsOf(draft))) {
      if (!conn || !auth.ok) {
        mounts.push({ account, path, ok: false, message: "凭据没过，没查" });
        continue;
      }
      try {
        const entries = await cd2ListDir(conn, path);
        mounts.push({ account, path, ok: true, entries, message: `能列出来，${entries} 个条目` });
      } catch (err) {
        mounts.push({ account, path, ok: false, message: messageOf(err) });
      }
    }
    return { system, auth, mounts, ...(copy ? { copy } : {}) };
  });
}
