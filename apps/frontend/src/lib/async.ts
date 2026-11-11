/**
 * 一批请求限着并发跑：结果按输入的顺序回来。
 * 设置页的「检查」要逐个列几十个目录（每个任务目录一次），一个个等要十几秒；全撒出去又会一下子压到 OpenList / CD2 和后面的网盘上
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
