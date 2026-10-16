import { ServiceError } from './flowus.mjs';

export const SETTINGS_HELP = Object.freeze({
  failedTaskRetentionHours: '失败创建与上传任务保留小时数，默认168（7天），允许1–8760；附件回收总开关控制清理。',
  autoSave: '是否自动保存画布内容，默认true。',
  assetGcEnabled: '是否自动回收未使用的应用图片，默认true；关闭时保留候选时间，不标记或删除候选。',
  assetGcGraceHours: '未使用图片的回收宽限小时数，默认24；允许0–8760有限小数，0仍须两次相隔至少60秒扫描。停用时间计入宽限期。',
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** 补齐旧版缺失字段并严格校验；输入持久化settings，输出保留未知旧字段的完整设置，不写远端。 */
export function normalizeSettings(value, status = 409) {
  if (!object(value) || typeof value.autoSave !== 'boolean') throw new ServiceError(status, '全局自动保存设置格式错误');
  const assetGcEnabled = value.assetGcEnabled === undefined ? true : value.assetGcEnabled;
  const assetGcGraceHours = value.assetGcGraceHours === undefined ? 24 : value.assetGcGraceHours;
  if (typeof assetGcEnabled !== 'boolean') throw new ServiceError(status, '附件回收开关须为布尔值；回收已停止');
  if (typeof assetGcGraceHours !== 'number' || !Number.isFinite(assetGcGraceHours) || assetGcGraceHours < 0 || assetGcGraceHours > 8760) throw new ServiceError(status, '附件回收宽限须为0–8760之间的有限小时数；回收已停止');
  const failedTaskRetentionHours = value.failedTaskRetentionHours ?? 168;
  if (typeof failedTaskRetentionHours !== 'number' || !Number.isFinite(failedTaskRetentionHours) || failedTaskRetentionHours < 1 || failedTaskRetentionHours > 8760) throw new ServiceError(status, '失败任务保留期须为1–8760小时；回收已停止');
  return { ...value, assetGcEnabled, assetGcGraceHours, failedTaskRetentionHours };
}

/** 合并一次设置更新；输入已保存值和部分字段，输出完整设置，旧前端autoSave更新不会清除回收字段。 */
export function mergeSettings(current, patch) {
  if (!object(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !Object.hasOwn(SETTINGS_HELP, key))) throw new ServiceError(400, '设置更新字段无效');
  return normalizeSettings({ ...normalizeSettings(current), ...patch }, 400);
}
