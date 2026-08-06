import {
  ProviderSendError,
  ProviderTemplateError,
  metaTemplateErrorMessage,
} from './provider-errors';
import {
  SendTemplateMessageInput,
  SendTemplateMessageResult,
  SubmitTemplateInput,
  SubmitTemplateResult,
  WhatsAppProvider,
} from './whatsapp-provider.interface';

export const META_GRAPH_API_BASE_URL = 'https://graph.facebook.com';
export const META_GRAPH_API_VERSION = 'v21.0';
export const META_DEFAULT_TIMEOUT_MS = 10000;

export interface MetaCloudApiConfig {
  token: string;
  phoneNumberId: string;
  wabaId: string;
  /** Injectable for tests; production default META_DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Meta Cloud API adapter (design §7, AD2). Zero dependencies: native global
 * `fetch` + `AbortSignal.timeout`.
 *
 * - send: POST /v21.0/{phoneNumberId}/messages (Bearer token), template body
 *   parameters derived from the input variables, 10s timeout.
 * - submit: POST /v21.0/{wabaId}/message_templates; non-2xx bodies map the
 *   Meta `error.code` (e.g. 131049 marketing-mislabel) into
 *   ProviderTemplateError.
 */
export class MetaCloudApiProvider implements WhatsAppProvider {
  readonly name = 'meta' as const;

  constructor(private readonly config: MetaCloudApiConfig) {}

  async sendTemplate(
    input: SendTemplateMessageInput,
  ): Promise<SendTemplateMessageResult> {
    const url = `${META_GRAPH_API_BASE_URL}/${META_GRAPH_API_VERSION}/${this.config.phoneNumberId}/messages`;
    const response = await this.request(url, this.sendTemplateBody(input));

    if (!response.ok) {
      throw new ProviderSendError(
        `meta_http_${response.status}`,
        await this.errorBodyText(response),
      );
    }

    const body = (await response.json()) as {
      messages?: Array<{ id?: string }>;
    };
    const providerMessageId = body.messages?.[0]?.id;
    if (!providerMessageId) {
      throw new ProviderSendError(
        'meta_invalid_response',
        'Meta send response missing messages[0].id',
      );
    }
    return { providerMessageId };
  }

  async submitTemplate(
    input: SubmitTemplateInput,
  ): Promise<SubmitTemplateResult> {
    const url = `${META_GRAPH_API_BASE_URL}/${META_GRAPH_API_VERSION}/${this.config.wabaId}/message_templates`;
    const response = await this.request(url, this.submitTemplateBody(input));

    if (!response.ok) {
      throw this.mapSubmitError(await response.text());
    }

    const body = (await response.json()) as { id?: string; status?: string };
    if (!body.id || !body.status) {
      throw new ProviderTemplateError(
        -1,
        'Meta submit response missing id or status',
      );
    }
    return { providerTemplateId: body.id, providerStatus: body.status };
  }

  private sendTemplateBody(input: SendTemplateMessageInput): object {
    return {
      messaging_product: 'whatsapp',
      to: input.to,
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.language },
        components: [
          {
            type: 'body',
            parameters: input.variables.map((variable) => ({
              type: 'text',
              text: variable.value,
            })),
          },
        ],
      },
    };
  }

  private submitTemplateBody(input: SubmitTemplateInput): object {
    return {
      name: input.name,
      language: input.language,
      category: input.category,
      components: [
        {
          type: 'BODY',
          text: input.bodyTemplate,
          example: { body_text: [Object.values(input.sampleVariables)] },
        },
      ],
    };
  }

  private async request(url: string, body: object): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? META_DEFAULT_TIMEOUT_MS;
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      if (errorName === 'TimeoutError' || errorName === 'AbortError') {
        throw new ProviderSendError(
          'meta_timeout',
          `Meta Cloud API request timed out after ${timeoutMs}ms`,
        );
      }
      throw new ProviderSendError(
        'meta_network',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async errorBodyText(response: Response): Promise<string> {
    const rawBody = await response.text();
    try {
      const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
      if (parsed.error?.message) {
        return parsed.error.message;
      }
    } catch {
      // Not JSON — the raw body is the best detail we have.
    }
    return rawBody;
  }

  private mapSubmitError(rawBody: string): ProviderTemplateError {
    let metaCode = -1;
    let message = rawBody;
    try {
      const parsed = JSON.parse(rawBody) as {
        error?: { code?: number; message?: string };
      };
      if (typeof parsed.error?.code === 'number') {
        metaCode = parsed.error.code;
        message = metaTemplateErrorMessage(metaCode, parsed.error.message);
      } else if (parsed.error?.message) {
        message = parsed.error.message;
      }
    } catch {
      // Not JSON — keep the raw body as the message.
    }
    return new ProviderTemplateError(metaCode, message);
  }
}
