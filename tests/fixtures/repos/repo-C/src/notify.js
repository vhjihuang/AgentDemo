// 与 repo-A 调用方式相同，但依赖版本为 4.17.21
// 期望：
//   GHSA-29mw / GHSA-35jh 已被 4.17.21 修复 → VERSION_NOT_AFFECTED
//   GHSA-r5fr 仍受影响(修复于 4.18.0) 且调用了 _.template → AFFECTED
//   GHSA-xxjr 仍受影响(修复于 4.17.23) 但未调用 unset/omit/pullAt → NOT_CALLED
import _ from 'lodash';

export function renderNotice(tpl, data) {
  return _.template(tpl)(data);
}
