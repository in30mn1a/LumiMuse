import type { AttachmentItem } from '@/lib/chat-engine';

type LocalAttachmentItem = AttachmentItem & { id?: string };

export function prepareAttachmentPayload(attachments: ReadonlyArray<LocalAttachmentItem>): AttachmentItem[] | undefined {
  if (attachments.length === 0) return undefined;

  return attachments.map(({ id: _id, ...attachment }) => {
    if (attachment.type !== 'image') {
      return { ...attachment };
    }

    const { data: _data, ...imageAttachment } = attachment;
    return imageAttachment;
  });
}
