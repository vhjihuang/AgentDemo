// 声明了 lodash 依赖，但通知渲染改用纯字符串替换，全程未 import lodash
// 期望：4 条漏洞全部 NOT_AFFECTED / NOT_CALLED
export function renderNotice(tpl, data) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => String(data[key] ?? ''));
}
