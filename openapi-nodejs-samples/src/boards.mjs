export async function* queryBoards(api, { size = 200, status = null, online = null } = {}) {
  let cursor = null;
  do {
    const page = await api('/open-api/board/query', { scroller: { cursor, size }, status, online });
    yield page;
    if (!page.hasMore) return;
    if (!page.nextCursor?.id || page.nextCursor.id === cursor?.id) throw new Error('板卡查询返回无效 nextCursor');
    cursor = page.nextCursor; // 后续批次保持相同筛选条件。
  } while (true);
}
