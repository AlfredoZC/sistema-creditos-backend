import { TemplateCategory } from '../../common/enums';
import {
  MetaCloudApiConfig,
  MetaCloudApiProvider,
} from './meta-cloud-api.provider';
import { ProviderTemplateError } from './provider-errors';
import {
  SendTemplateMessageInput,
  SubmitTemplateInput,
} from './whatsapp-provider.interface';

const fetchMock = jest.fn();
const originalFetch = global.fetch;

function okJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number, rawBody: string): Response {
  return {
    ok: false,
    status,
    text: async () => rawBody,
  } as unknown as Response;
}

function templateInput(to = '+59170000001'): SendTemplateMessageInput {
  return {
    to,
    templateName: 'payment_reminder',
    language: 'es',
    variables: [
      { name: '1', value: '8155.19' },
      { name: '2', value: '2026-08-05' },
    ],
  };
}

function submitInput(): SubmitTemplateInput {
  return {
    name: 'payment_reminder',
    category: TemplateCategory.UTILITY,
    language: 'es',
    bodyTemplate: 'Tu saldo es {{1}}',
    sampleVariables: { '1': '8155.19', '2': '2026-08-05' },
  };
}

describe('MetaCloudApiProvider (design §7)', () => {
  const config: MetaCloudApiConfig = {
    token: 'test-token',
    phoneNumberId: '123456789',
    wabaId: '987654321',
  };
  let provider: MetaCloudApiProvider;

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    fetchMock.mockReset();
    provider = new MetaCloudApiProvider(config);
  });

  describe('sendTemplate', () => {
    it('posts the template message to the phone-number messages endpoint', async () => {
      fetchMock.mockResolvedValue(
        okJsonResponse({ messages: [{ id: 'wamid.META123' }] }),
      );

      const result = await provider.sendTemplate(templateInput());

      expect(result.providerMessageId).toBe('wamid.META123');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://graph.facebook.com/v21.0/123456789/messages');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        messaging_product: 'whatsapp',
        to: '+59170000001',
        type: 'template',
        template: {
          name: 'payment_reminder',
          language: { code: 'es' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: '8155.19' },
                { type: 'text', text: '2026-08-05' },
              ],
            },
          ],
        },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('maps a non-2xx response to ProviderSendError meta_http_<status>', async () => {
      fetchMock.mockResolvedValue(errorResponse(500, 'Internal Server Error'));

      await expect(
        provider.sendTemplate(templateInput()),
      ).rejects.toMatchObject({
        name: 'ProviderSendError',
        code: 'meta_http_500',
        message: 'Internal Server Error',
      });
    });

    it('extracts the Meta error message from a Meta error body', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(
          400,
          JSON.stringify({
            error: {
              message: '(#131030) Referenced object does not exist',
              code: 131030,
            },
          }),
        ),
      );

      await expect(
        provider.sendTemplate(templateInput()),
      ).rejects.toMatchObject({
        name: 'ProviderSendError',
        code: 'meta_http_400',
        message: '(#131030) Referenced object does not exist',
      });
    });

    it('surfaces AbortSignal.timeout firing as a typed meta_timeout error', async () => {
      const timeoutProvider = new MetaCloudApiProvider({
        ...config,
        timeoutMs: 5,
      });
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener('abort', () => {
              reject(
                Object.assign(
                  new Error('The operation was aborted due to timeout'),
                  { name: 'TimeoutError' },
                ),
              );
            });
          }),
      );

      await expect(
        timeoutProvider.sendTemplate(templateInput()),
      ).rejects.toMatchObject({
        name: 'ProviderSendError',
        code: 'meta_timeout',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a success body without messages[0].id', async () => {
      fetchMock.mockResolvedValue(okJsonResponse({}));

      await expect(
        provider.sendTemplate(templateInput()),
      ).rejects.toMatchObject({
        name: 'ProviderSendError',
        code: 'meta_invalid_response',
      });
    });

    it('maps transport failures to a typed meta_network error', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed'));

      await expect(
        provider.sendTemplate(templateInput()),
      ).rejects.toMatchObject({
        name: 'ProviderSendError',
        code: 'meta_network',
      });
    });
  });

  describe('submitTemplate', () => {
    it('posts the template to the WABA message_templates endpoint', async () => {
      fetchMock.mockResolvedValue(
        okJsonResponse({ id: '1029384756', status: 'IN_APPROVAL' }),
      );

      const result = await provider.submitTemplate(submitInput());

      expect(result).toEqual({
        providerTemplateId: '1029384756',
        providerStatus: 'IN_APPROVAL',
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/987654321/message_templates',
      );
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        name: 'payment_reminder',
        language: 'es',
        category: 'utility',
        components: [
          {
            type: 'BODY',
            text: 'Tu saldo es {{1}}',
            example: { body_text: [['8155.19', '2026-08-05']] },
          },
        ],
      });
    });

    it('maps Meta error code 131049 to the marketing-mislabel template error', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(
          400,
          JSON.stringify({
            error: {
              message:
                'Something went wrong when creating the message template',
              code: 131049,
              error_subcode: 2468018,
            },
          }),
        ),
      );

      const rejection = provider.submitTemplate(submitInput());

      await expect(rejection).rejects.toBeInstanceOf(ProviderTemplateError);
      await expect(rejection).rejects.toMatchObject({
        name: 'ProviderTemplateError',
        metaCode: 131049,
      });
      await expect(rejection).rejects.toThrow(/marketing/);
    });

    it('falls back to the raw body when the error is not a Meta JSON error', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(502, '<html>502 Bad Gateway</html>'),
      );

      await expect(
        provider.submitTemplate(submitInput()),
      ).rejects.toMatchObject({
        name: 'ProviderTemplateError',
        metaCode: -1,
        message: '<html>502 Bad Gateway</html>',
      });
    });
  });
});
