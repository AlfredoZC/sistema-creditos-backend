import { ProviderSendError } from './provider-errors';
import {
  SendTemplateMessageInput,
  SendTemplateMessageResult,
  SubmitTemplateInput,
  SubmitTemplateResult,
  WhatsAppProvider,
} from './whatsapp-provider.interface';

/** A recorded sendTemplate call: the input plus the result it produced. */
export interface MockSentRecord {
  input: SendTemplateMessageInput;
  result: SendTemplateMessageResult;
}

/** A recorded submitTemplate call: the input plus the result it produced. */
export interface MockSubmittedRecord {
  input: SubmitTemplateInput;
  result: SubmitTemplateResult;
}

/**
 * Deterministic in-memory provider (design §7). It IS the runtime mock for
 * `WHATSAPP_PROVIDER=mock` AND the integration-suite fake — the same object,
 * no test-only production path.
 *
 * - `sent` / `submitted`: FIFO records of every call, for test assertions.
 * - wamids are deterministic: `wamid.mock.<n>` (n = 1, 2, 3, ...).
 * - `failNext: true` makes the NEXT sendTemplate reject with a typed
 *   ProviderSendError and resets, so retry/failure flows can be tested.
 */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'mock' as const;

  readonly sent: MockSentRecord[] = [];
  readonly submitted: MockSubmittedRecord[] = [];

  failNext = false;

  private nextWamid = 1;

  async sendTemplate(
    input: SendTemplateMessageInput,
  ): Promise<SendTemplateMessageResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new ProviderSendError(
        'meta_http_500',
        'Mock provider forced failure (failNext)',
      );
    }
    const result: SendTemplateMessageResult = {
      providerMessageId: `wamid.mock.${this.nextWamid}`,
    };
    this.nextWamid += 1;
    this.sent.push({ input, result });
    return result;
  }

  async submitTemplate(
    input: SubmitTemplateInput,
  ): Promise<SubmitTemplateResult> {
    const result: SubmitTemplateResult = {
      providerTemplateId: `template.mock.${this.submitted.length + 1}`,
      providerStatus: 'IN_APPROVAL',
    };
    this.submitted.push({ input, result });
    return result;
  }
}
