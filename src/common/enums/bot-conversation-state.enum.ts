/**
 * Maps the PG enum type `bot_conversation_state` (migration 1786000000003
 * WhatsAppBot). Value order matches the type declaration exactly.
 */
export enum BotConversationState {
  UNIDENTIFIED = 'unidentified',
  AWAITING_DOCUMENT = 'awaiting_document',
  IDENTIFIED = 'identified',
}
