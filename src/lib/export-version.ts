/**
 * 导出文件版本号集中维护点。
 *
 * 约定：
 *   - 当 export payload 的 schema 出现"新版本能读、旧代码读不了"的破坏性变更时，
 *     必须递增 EXPORT_VERSION，并在 CHANGELOG 里记录。
 *   - 兼容性扩展（仅新增可选字段、不改字段含义）不需要升级版本号。
 *   - import 端会拒绝 version > EXPORT_VERSION 的文件，提示用户升级应用，
 *     避免读到不认识的字段后写出半成品数据。
 *
 * 历史：
 *   - v2（当前）：包含 characters / memories / conversations / version / exported_at
 *   - v1（已淘汰，仍可被 import 兼容读取）：早期单角色格式
 */
export const EXPORT_VERSION = 2;
