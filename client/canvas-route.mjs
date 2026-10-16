const slugPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/; // 与后端保持一致；不自动转小写或去空格。

/** 判断解码后的固定链接标识是否合法；不额外限制后端允许的词。 */
export function validCanvasSlug(slug) { return typeof slug === 'string' && slugPattern.test(slug); }

/** 解析画布路径；仅解码一次，非法编码或格式不发起画布请求。 */
export function canvasRoute(path) {
  if (!path.startsWith('/c/')) return { kind: 'home' };
  const match = path.match(/^\/c\/([^/]+)\/?$/);
  if (!match) return { kind: 'invalid' };
  try {
    const slug = decodeURIComponent(match[1]);
    return validCanvasSlug(slug) ? { kind: 'canvas', slug } : { kind: 'invalid' };
  } catch { return { kind: 'invalid' }; }
}

/** 只有合法且确实不存在的画布才提供创建确认；其它404仍显示读取错误。 */
export function isMissingCanvas(failure, slug) {
  return validCanvasSlug(slug) && failure.status === 404 && failure.code === 'CANVAS_NOT_FOUND';
}
