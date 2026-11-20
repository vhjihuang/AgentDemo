// 通知模板渲染：显式引入 lodash 并调用 _.template
// 命中的受影响 API: _.template → GHSA-35jh-r3h4-6jhm / GHSA-r5fr-rjxr-66jc
import _ from 'lodash';

/**
 * 把模板字符串与用户数据合成最终通知文案
 * @param {string} tpl 模板字符串
 * @param {Record<string, unknown>} data 渲染数据
 * @returns {string}
 */
export function renderNotice(tpl, data) {
  return _.template(tpl)(data);
}
