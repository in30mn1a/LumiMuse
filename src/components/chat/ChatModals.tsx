'use client';

import type { ComponentProps, ComponentType, ReactNode } from 'react';
import dynamic from 'next/dynamic';
import type { Character, Conversation, Message } from '@/types';
import RenameConvModal from './RenameConvModal';
import DeleteConvModal from './DeleteConvModal';
import DuplicateConvModal, { type DuplicateMode } from './DuplicateConvModal';
import type ResetExtractionModalType from './ResetExtractionModal';
import type { TokenBreakdownItem, RealUsage, MemoryInjectionInfo } from './TokenBreakdownModal';

type ResetExtractionModalProps = ComponentProps<typeof ResetExtractionModalType>;

const DefaultResetExtractionModal = dynamic(() => import('./ResetExtractionModal'));
const DefaultImageManagerModal = dynamic(() => import('./ImageManagerModal'));
const DefaultTokenBreakdownModal = dynamic(() => import('./TokenBreakdownModal'));

export interface ChatModalsProps {
  renameOpen: boolean;
  renameValue: string;
  onCloseRename: () => void;
  onConfirmRename: (newTitle: string) => void | Promise<void>;
  deleteOpen: boolean;
  onCloseDelete: () => void;
  onConfirmDelete: () => void | Promise<void>;
  duplicateOpen: boolean;
  onCloseDuplicate: () => void;
  onConfirmDuplicate: (mode: DuplicateMode) => void | Promise<void>;
  resetExtractionOpen: boolean;
  activeConvId: string | null;
  activeConversation: Conversation | null;
  serverUnextractedCount: number;
  memoryExtractStatus: 'idle' | 'extracting' | 'done' | 'failed';
  onCloseResetExtraction: () => void;
  onSubmitResetExtraction: (messageIds: string[] | undefined, action: 'reset' | 'mark') => Promise<void>;
  onToggleIgnore: () => Promise<void>;
  onManualExtract: () => Promise<void>;
  loadAllMessages: (conversationId: string) => Promise<Message[]>;
  ResetExtractionModalComponent?: ComponentType<ResetExtractionModalProps>;
  imageManagerOpen?: boolean;
  character?: Character | null;
  onCloseImageManager?: () => void;
  onAfterBatchDelete?: () => Promise<void>;
  showToast?: (message: string, type?: 'error' | 'info') => void;
  tokenBreakdownOpen?: boolean;
  onCloseTokenBreakdown?: () => void;
  tokenBreakdownItems?: TokenBreakdownItem[];
  lastRealUsage?: RealUsage | null;
  lastMemoryInjection?: MemoryInjectionInfo | null;
  children?: ReactNode;
}

export function ChatModals({
  renameOpen,
  renameValue,
  onCloseRename,
  onConfirmRename,
  deleteOpen,
  onCloseDelete,
  onConfirmDelete,
  duplicateOpen,
  onCloseDuplicate,
  onConfirmDuplicate,
  resetExtractionOpen,
  activeConvId,
  activeConversation,
  serverUnextractedCount,
  memoryExtractStatus,
  onCloseResetExtraction,
  onSubmitResetExtraction,
  onToggleIgnore,
  onManualExtract,
  loadAllMessages,
  ResetExtractionModalComponent = DefaultResetExtractionModal,
  imageManagerOpen,
  character,
  onCloseImageManager,
  onAfterBatchDelete,
  showToast,
  tokenBreakdownOpen,
  onCloseTokenBreakdown,
  tokenBreakdownItems,
  lastRealUsage,
  lastMemoryInjection,
  children,
}: ChatModalsProps) {
  return (
    <>
      {renameOpen && (
        <RenameConvModal
          open={renameOpen}
          initialValue={renameValue}
          onClose={onCloseRename}
          onConfirm={onConfirmRename}
        />
      )}

      {deleteOpen && (
        <DeleteConvModal
          open={deleteOpen}
          onClose={onCloseDelete}
          onConfirm={onConfirmDelete}
        />
      )}

      {duplicateOpen && (
        <DuplicateConvModal
          open={duplicateOpen}
          onClose={onCloseDuplicate}
          onConfirm={onConfirmDuplicate}
        />
      )}

      {resetExtractionOpen && (
        <ResetExtractionModalComponent
          open={resetExtractionOpen}
          conversationId={activeConvId}
          conversation={activeConversation}
          serverUnextractedCount={serverUnextractedCount}
          memoryExtractStatus={memoryExtractStatus}
          onClose={onCloseResetExtraction}
          onSubmit={onSubmitResetExtraction}
          onToggleIgnore={onToggleIgnore}
          onManualExtract={onManualExtract}
          loadAllMessages={loadAllMessages}
        />
      )}

      {!children && imageManagerOpen && character && onCloseImageManager && onAfterBatchDelete && showToast && (
        <DefaultImageManagerModal
          open={imageManagerOpen}
          character={character}
          onClose={onCloseImageManager}
          onAfterBatchDelete={onAfterBatchDelete}
          showToast={showToast}
        />
      )}

      {!children && tokenBreakdownOpen && onCloseTokenBreakdown && tokenBreakdownItems && (
        <DefaultTokenBreakdownModal
          open={tokenBreakdownOpen}
          onClose={onCloseTokenBreakdown}
          items={tokenBreakdownItems}
          lastRealUsage={lastRealUsage ?? null}
          lastMemoryInjection={lastMemoryInjection ?? null}
        />
      )}

      {children}
    </>
  );
}

export default ChatModals;
