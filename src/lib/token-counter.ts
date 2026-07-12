// Token 估算
//
// 实现策略：
// 1. 首选 js-tiktoken 的 cl100k_base BPE 分词器（与 GPT-3.5/4 / 大部分 OpenAI
//    兼容协议一致），误差通常 < 5%。
// 2. encoder 在首次调用时 lazy-init；初始化失败会进入短暂冷却期，冷却后
//    自动重试，避免瞬时依赖故障把应用永久锁死在粗略估算上。
// 3. 接口保持完全同步（js-tiktoken 是纯 JS 同步 API），所有调用方无需改动。
//
// 注：Anthropic 模型理论上用不同的 BPE 词表，但项目走的是 "OpenAI 兼容"
// 协议（chat completions），cl100k_base 在中英文 / 代码 / 标点上的整体
// 误差仍显著小于按字符规则估算。
import type { Tiktoken } from 'js-tiktoken/lite';
import { estimateClientTokens } from './token-counter-client';

let encoder: Tiktoken | null = null;
let encoderInitFailed = false;
let encoderInitFailedAt = 0;
let lastFallbackWarnAt = 0;

const ENCODER_INIT_RETRY_COOLDOWN_MS = 60_000;
const FALLBACK_WARN_COOLDOWN_MS = 60_000;

export const TOKEN_COUNTER_EXACT_ALGORITHM = 'cl100k_base-js-tiktoken-v1';
export const TOKEN_COUNTER_FALLBACK_ALGORITHM = 'client-estimate-v1';

export interface TokenEstimate {
  tokenCount: number;
  algorithm: string;
}

function warnFallback(reason: string): void {
  const now = Date.now();
  if (lastFallbackWarnAt > 0 && now - lastFallbackWarnAt < FALLBACK_WARN_COOLDOWN_MS) {
    return;
  }
  lastFallbackWarnAt = now;
  console.warn(`[token counter] ${reason}; using temporary fallback estimate until encoder is available.`);
}

function getEncoder(): Tiktoken | null {
  if (encoder) return encoder;
  if (encoderInitFailed && Date.now() - encoderInitFailedAt < ENCODER_INIT_RETRY_COOLDOWN_MS) {
    return null;
  }
  try {
    // 使用 lite 版 + 显式 import ranks，避免触发完整 registry 的副作用加载
    const { Tiktoken: TiktokenCls } = require('js-tiktoken/lite') as typeof import('js-tiktoken/lite');
    const cl100k = require('js-tiktoken/ranks/cl100k_base') as typeof import('js-tiktoken/ranks/cl100k_base');
    encoder = new TiktokenCls(cl100k.default ?? cl100k);
    encoderInitFailed = false;
    encoderInitFailedAt = 0;
    return encoder;
  } catch (error) {
    encoderInitFailed = true;
    encoderInitFailedAt = Date.now();
    warnFallback(`failed to initialize token encoder${error instanceof Error ? `: ${error.message}` : ''}`);
    return null;
  }
}

/**
 * 估算文本的 token 数量。
 *
 * - 优先使用 cl100k_base BPE 分词器（精确）
 * - encoder 初始化失败 / encode 抛错时临时回退到粗略估算；初始化失败会在冷却后重试
 * - 同步返回 number，与原有接口完全一致
 */
export function estimateTokens(text: string): number {
  return estimateTokensWithAlgorithm(text).tokenCount;
}

/**
 * 返回 token 数及实际采用的算法版本，供持久化计数建立可验证 provenance。
 * encoder 临时不可用或单次 encode 失败时会明确标记 fallback 版本，避免后续
 * 把粗略估算误当成 cl100k_base 的可复用结果。
 */
export function estimateTokensWithAlgorithm(text: string): TokenEstimate {
  if (!text) {
    return {
      tokenCount: 0,
      algorithm: getEncoder() ? TOKEN_COUNTER_EXACT_ALGORITHM : TOKEN_COUNTER_FALLBACK_ALGORITHM,
    };
  }

  const enc = getEncoder();
  if (enc) {
    try {
      return {
        tokenCount: enc.encode(text).length,
        algorithm: TOKEN_COUNTER_EXACT_ALGORITHM,
      };
    } catch (error) {
      // 单次 encode 失败不污染全局状态，仅本次回退
      warnFallback(`token encoder failed to encode text${error instanceof Error ? `: ${error.message}` : ''}`);
    }
  }

  return {
    tokenCount: estimateClientTokens(text),
    algorithm: TOKEN_COUNTER_FALLBACK_ALGORITHM,
  };
}

/** 当前一次新计数会采用的算法版本；不会对消息正文执行 encode。 */
export function getTokenCounterAlgorithmVersion(): string {
  return getEncoder() ? TOKEN_COUNTER_EXACT_ALGORITHM : TOKEN_COUNTER_FALLBACK_ALGORITHM;
}
