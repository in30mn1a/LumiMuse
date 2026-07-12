import { createHash } from 'crypto';
import type {
  Message,
  MessageAttachment,
  MessageMetadata,
  MessageTokenCountProvenance,
} from '@/types';
import {
  estimateTokensWithAlgorithm,
  getTokenCounterAlgorithmVersion,
} from '@/lib/token-counter';

const TOKEN_COUNT_PROVENANCE_VERSION = 1;

type MessageRole = Message['role'];

export interface MessageTokenCountResult {
  tokenCount: number;
  provenance: MessageTokenCountProvenance;
}

export interface ResolvedMessageTokenCount extends MessageTokenCountResult {
  reused: boolean;
}

export function buildMessageTokenCountContent(
  content: string,
  role: MessageRole,
  attachments?: ReadonlyArray<MessageAttachment>,
): string {
  if (role !== 'user' || !attachments || attachments.length === 0) return content;

  let combinedText = content;
  for (const attachment of attachments) {
    if (attachment.type === 'text') {
      combinedText += `\n\n[附件: ${attachment.name}]\n${attachment.data || ''}`;
    }
  }
  return combinedText;
}

function provenanceFingerprint(
  content: string,
  role: MessageRole,
  attachments: ReadonlyArray<MessageAttachment> | undefined,
  tokenCount: number,
  algorithm: string,
): string {
  const attachmentFields = attachments?.map(attachment => ({
    type: attachment.type,
    name: attachment.name,
    data: attachment.data,
    url: attachment.url,
    mimeType: attachment.mimeType,
  })) ?? [];
  return createHash('sha256')
    .update(JSON.stringify({ role, content, attachments: attachmentFields, tokenCount, algorithm }))
    .digest('hex');
}

export function createMessageTokenCount(
  content: string,
  role: MessageRole,
  attachments?: ReadonlyArray<MessageAttachment>,
): MessageTokenCountResult {
  const countedContent = buildMessageTokenCountContent(content, role, attachments);
  const estimate = estimateTokensWithAlgorithm(countedContent);
  return {
    tokenCount: estimate.tokenCount,
    provenance: {
      source: 'server',
      version: TOKEN_COUNT_PROVENANCE_VERSION,
      algorithm: estimate.algorithm,
      fingerprint: provenanceFingerprint(
        content,
        role,
        attachments,
        estimate.tokenCount,
        estimate.algorithm,
      ),
    },
  };
}

export function metadataWithTokenCountProvenance(
  metadata: MessageMetadata,
  provenance: MessageTokenCountProvenance,
): MessageMetadata {
  return { ...metadata, token_count_provenance: provenance };
}

function isTrustedMessageTokenCount(message: Message): boolean {
  const provenance = message.metadata.token_count_provenance;
  if (!provenance || provenance.source !== 'server') return false;
  if (provenance.version !== TOKEN_COUNT_PROVENANCE_VERSION) return false;
  if (provenance.algorithm !== getTokenCounterAlgorithmVersion()) return false;
  if (!Number.isInteger(message.token_count) || message.token_count < 0) return false;

  return provenance.fingerprint === provenanceFingerprint(
    message.content,
    message.role,
    message.metadata.attachments,
    message.token_count,
    provenance.algorithm,
  );
}

export function resolveMessageTokenCount(message: Message): ResolvedMessageTokenCount {
  if (isTrustedMessageTokenCount(message)) {
    return {
      tokenCount: message.token_count,
      provenance: message.metadata.token_count_provenance!,
      reused: true,
    };
  }

  return {
    ...createMessageTokenCount(message.content, message.role, message.metadata.attachments),
    reused: false,
  };
}
