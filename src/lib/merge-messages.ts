/**
 * 合并连续同 role 消息，供 chat-engine 与 preset-assembler 共用。
 *
 * 规则（来自 chat-engine.ts 原打印逻辑，system 不合并以保留多个 system 块的位置独立性）：
 *   - 相邻两条 role 相同且 role !== 'system' → 合并到前一条
 *   - 任一条 content 是数组（多模态）时，归一化文本部分并保留图片顺序
 */

import { ChatMessage } from '@/lib/api-client';

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };
type Part = TextPart | ImagePart;

export function mergeConsecutiveRoles(result: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const msg of result) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role && last.role !== 'system') {
      const lastIsArray = Array.isArray(last.content);
      const curIsArray = Array.isArray(msg.content);

      if (!lastIsArray && !curIsArray) {
        last.content = `${last.content as string}\n\n${msg.content as string}`;
      } else {
        const lastParts: Part[] = lastIsArray
          ? [...(last.content as Part[])]
          : [{ type: 'text', text: last.content as string }];
        const curParts: Part[] = curIsArray
          ? (msg.content as Part[])
          : [{ type: 'text', text: msg.content as string }];

        const firstTextIdx = lastParts.findIndex(p => p.type === 'text');
        const curTextSegments: string[] = [];
        const curImages: Part[] = [];
        for (const part of curParts) {
          if (part.type === 'text') {
            if (part.text) curTextSegments.push(part.text);
          } else {
            curImages.push(part);
          }
        }
        const curTextJoined = curTextSegments.join('\n\n');

        if (curTextJoined) {
          if (firstTextIdx >= 0) {
            const firstText = lastParts[firstTextIdx] as TextPart;
            lastParts[firstTextIdx] = { type: 'text', text: `${firstText.text}\n\n${curTextJoined}` };
          } else {
            lastParts.unshift({ type: 'text', text: curTextJoined });
          }
        }
        for (const img of curImages) lastParts.push(img);

        last.content = lastParts;
      }
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }
  return merged;
}
