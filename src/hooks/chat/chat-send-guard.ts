export function canBeginChatSend(
  activeConversationId: string | null,
  creatingConversation: boolean,
  activeStreams: ReadonlySet<string>,
): boolean {
  return activeConversationId
    ? !activeStreams.has(activeConversationId)
    : !creatingConversation;
}
