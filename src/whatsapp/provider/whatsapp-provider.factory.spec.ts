jest.mock('./meta-cloud-api.provider', () => {
  const actual = jest.requireActual('./meta-cloud-api.provider');
  const MockedMetaCloudApiProvider = jest.fn(function (
    this: unknown,
    config: unknown,
  ) {
    // Record construction, then behave exactly like the real adapter.
    return Reflect.construct(actual.MetaCloudApiProvider, [config]);
  });
  return { ...actual, MetaCloudApiProvider: MockedMetaCloudApiProvider };
});

import { ConfigService } from '@nestjs/config';
import { MetaCloudApiProvider } from './meta-cloud-api.provider';
import { MockWhatsAppProvider } from './mock-whatsapp-provider';
import { createProvider } from './whatsapp-provider.factory';
import { SendTemplateMessageInput } from './whatsapp-provider.interface';

const MockedMetaCloudApiProvider = MetaCloudApiProvider as unknown as jest.Mock;

function configServiceWith(
  env: Record<string, string | undefined>,
): ConfigService {
  return {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
}

function templateInput(): SendTemplateMessageInput {
  return {
    to: '+59170000001',
    templateName: 'payment_reminder',
    language: 'es',
    variables: [{ name: '1', value: '8155.19' }],
  };
}

describe('whatsapp provider factory (design §7)', () => {
  beforeEach(() => {
    MockedMetaCloudApiProvider.mockClear();
  });

  it('Mock provider isolation: meta branch never entered, adapter never constructed', async () => {
    const getMock = jest.fn((key: string) =>
      key === 'WHATSAPP_PROVIDER' ? 'mock' : undefined,
    );
    const fetchSpy = jest.spyOn(global, 'fetch');

    const provider = createProvider({
      get: getMock,
    } as unknown as ConfigService);

    expect(provider).toBeInstanceOf(MockWhatsAppProvider);
    expect(provider.name).toBe('mock');
    expect(MockedMetaCloudApiProvider).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalledWith('WHATSAPP_TOKEN');

    // The factory-returned mock is fully usable and never touches the network.
    const result = await provider.sendTemplate(templateInput());
    expect(result.providerMessageId).toBe('wamid.mock.1');
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('returns the Meta adapter for WHATSAPP_PROVIDER=meta with full env', () => {
    const provider = createProvider(
      configServiceWith({
        WHATSAPP_PROVIDER: 'meta',
        WHATSAPP_TOKEN: 'token',
        WHATSAPP_PHONE_NUMBER_ID: '123456789',
        WHATSAPP_WABA_ID: '987654321',
      }),
    );

    expect(provider.name).toBe('meta');
    expect(MockedMetaCloudApiProvider).toHaveBeenCalledTimes(1);
    expect(MockedMetaCloudApiProvider.mock.calls[0][0]).toEqual({
      token: 'token',
      phoneNumberId: '123456789',
      wabaId: '987654321',
    });
  });

  it('fails fast when meta env is missing entirely', () => {
    expect(() =>
      createProvider(configServiceWith({ WHATSAPP_PROVIDER: 'meta' })),
    ).toThrow(/WHATSAPP_TOKEN/);
    expect(() =>
      createProvider(configServiceWith({ WHATSAPP_PROVIDER: 'meta' })),
    ).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
    expect(() =>
      createProvider(configServiceWith({ WHATSAPP_PROVIDER: 'meta' })),
    ).toThrow(/WHATSAPP_WABA_ID/);
    expect(MockedMetaCloudApiProvider).not.toHaveBeenCalled();
  });

  it('fails fast when only part of the meta env is present', () => {
    expect(() =>
      createProvider(
        configServiceWith({
          WHATSAPP_PROVIDER: 'meta',
          WHATSAPP_TOKEN: 'token',
        }),
      ),
    ).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
    expect(MockedMetaCloudApiProvider).not.toHaveBeenCalled();
  });

  it('throws on first injection for an unknown provider value', () => {
    expect(() =>
      createProvider(configServiceWith({ WHATSAPP_PROVIDER: 'twilio' })),
    ).toThrow(/Unsupported WHATSAPP_PROVIDER 'twilio'/);
    expect(MockedMetaCloudApiProvider).not.toHaveBeenCalled();
  });

  it('throws on first injection when WHATSAPP_PROVIDER is unset', () => {
    expect(() => createProvider(configServiceWith({}))).toThrow(
      /Unsupported WHATSAPP_PROVIDER/,
    );
  });
});
