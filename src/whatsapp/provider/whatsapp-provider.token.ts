/**
 * Injection token for the WhatsApp provider port (design AD1). The factory
 * (design §7) selects MockWhatsAppProvider or MetaCloudApiProvider from
 * WHATSAPP_PROVIDER and fails fast on unknown values; with 'mock' the Meta
 * adapter is never constructed (spec "Mock provider isolation").
 *
 * Lives in its own leaf file (no imports) so services can inject the port
 * without a circular module dependency: whatsapp.module.ts re-exports it for
 * module-level consumers.
 */
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
