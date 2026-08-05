import { TemplateCategory } from '../../common/enums';

/**
 * WhatsApp provider port (design §7). Every concrete provider — mock, Meta
 * Cloud API, or a future Twilio adapter — implements this interface.
 *
 * Messages and templates are sent through the port so services stay
 * provider-agnostic and the integration suite can run against the mock.
 */

/** One template body variable: `{ name: '1', value: '...' }` for `{{1}}`. */
export interface TemplateVariable {
  name: string;
  value: string;
}

export interface SendTemplateMessageInput {
  /** Normalized phone (canonical E.164-ish, e.g. +59170000001). */
  to: string;
  templateName: string;
  language: string;
  variables: TemplateVariable[];
}

export interface SendTemplateMessageResult {
  /** WhatsApp message id (wamid), used for status tracking/dedupe. */
  providerMessageId: string;
}

export interface SubmitTemplateInput {
  name: string;
  category: TemplateCategory;
  language: string;
  /** Body template text with `{{1}}..{{N}}` placeholders. */
  bodyTemplate: string;
  /** Sample values per placeholder name (Meta example content). */
  sampleVariables: Record<string, string>;
}

export interface SubmitTemplateResult {
  providerTemplateId: string;
  /** Raw Meta status mirror, e.g. IN_APPROVAL / APPROVED. */
  providerStatus: string;
}

export interface WhatsAppProvider {
  readonly name: 'mock' | 'meta';
  sendTemplate(
    input: SendTemplateMessageInput,
  ): Promise<SendTemplateMessageResult>;
  submitTemplate(input: SubmitTemplateInput): Promise<SubmitTemplateResult>;
}
