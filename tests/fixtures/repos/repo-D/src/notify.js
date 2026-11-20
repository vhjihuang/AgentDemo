// 包名来自运行时环境变量，静态分析无法确定最终加载的模块
// 期望：所有相关漏洞判为 NEED_MANUAL / DYN_IMPORT_UNRESOLVABLE
const engineName = process.env.NOTICE_ENGINE || 'lodash';

export async function renderNotice(tpl, data) {
  const engine = await import(engineName);
  const _ = engine.default ?? engine;
  return _.template(tpl)(data);
}
