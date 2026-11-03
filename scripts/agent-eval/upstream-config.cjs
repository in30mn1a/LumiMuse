/**
 * 上游验证与记忆整理评测共用的配置读取。
 *
 * 配置只来自环境变量或被 gitignore 的 .env.agent-eval.local，不读取数据库里的 provider，
 * 这样评测用哪个密钥由主人显式决定。任何输出都不得包含 apiKey。
 */
const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.resolve(__dirname, '..', '..', '.env.agent-eval.local');

function loadUpstreamConfig(env = process.env, envFile = ENV_FILE) {
  if (env === process.env && fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const apiBase = (env.AGENT_EVAL_API_BASE || '').trim().replace(/\/+$/, '');
  const apiKey = (env.AGENT_EVAL_API_KEY || '').trim();
  const models = (env.AGENT_EVAL_MODELS || '').split(',').map(model => model.trim()).filter(Boolean);
  const missing = [
    !apiBase && 'AGENT_EVAL_API_BASE',
    !apiKey && 'AGENT_EVAL_API_KEY',
    models.length === 0 && 'AGENT_EVAL_MODELS',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`缺少配置：${missing.join('、')}。请填写 .env.agent-eval.local 或设置同名环境变量。`);
  }
  return { apiBase, apiKey, models };
}

/** 上游错误可能回显密钥，写日志或落盘前统一替换。 */
function redactSecret(text, secret) {
  const value = String(text);
  return secret ? value.split(secret).join('***') : value;
}

module.exports = { loadUpstreamConfig, redactSecret };
