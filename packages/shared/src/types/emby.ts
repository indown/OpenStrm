/**
 * Emby 起播诊断：服务端替播放器走一遍首播要走的两段路，把每段用时摆出来。
 * 第一段是 Emby 自己回答 PlaybackInfo（strm 条目第一次被问到才探测媒体流），第二段是换直链。
 */

/** 直链换不到的原因；和后端 resolve 的判别联合一致 */
export type DirectLinkFailure =
  /** 没有能用的 115 账号：一个都没配，或者任务 / 路径映射指向的账号已删、改名、不是 115 */
  | "no-account"
  /** 路径不在任何挂载前缀之下，不该由我们接管 */
  | "not-mounted"
  /** 盘里找不到这个文件 */
  | "not-found"
  /** 找到了文件但拿不到直链 */
  | "no-url";

export interface PlaybackDiagnosis {
  item: {
    id: string;
    name: string;
    /** Emby 的 Type：Episode / Movie */
    type: string;
    /** 媒体源路径（strm 的内容），直链就是按它解析的 */
    path: string;
    /** true = 没指定 id，是我们挑的（最近入库、还没探测过的 strm 条目） */
    picked: boolean;
  };
  emby: {
    /** PlaybackInfo 来回用时（毫秒） */
    ms: number;
    /** 诊断前条目有几条媒体流：有 = Emby 早就探测过，这次没有探测开销 */
    streamsBefore: number;
    streamsAfter: number;
    /** 这次 PlaybackInfo 让 Emby 真的探测了一遍（之前没有流、现在有了） */
    probed: boolean;
    /** Emby 没回答（连不上、超时、非 2xx）；成功是 null */
    error: string | null;
  };
  link: {
    ok: boolean;
    /** ok 为 false 时的原因；"error" 是解析过程抛了异常 */
    reason: DirectLinkFailure | "error" | null;
    account: string | null;
    /** 找路径（逐级列目录）用时 */
    pathMs: number;
    /** 取链用时 */
    linkMs: number;
    /** 这一段总用时 */
    ms: number;
    error: string | null;
  };
  totalMs: number;
}
