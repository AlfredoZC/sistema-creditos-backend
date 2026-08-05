import { ConfigService } from '@nestjs/config';
import {
  MetaCloudApiConfig,
  MetaCloudApiProvider,
} from './meta-cloud-api.provider';
import { MockWhatsAppProvider } from './mock-whatsapp-provider';
import { WhatsAppProvider } from './whatsapp-provider.interface';

const REQUIRED_META_ENV = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_WABA_ID',
] as const;

/**
 * Provider factory (design §7). Selects the concrete adapter from
 * `WHATSAPP_PROVIDER` and fails fast on configuration errors.
 *
 * Isolation guarantee (spec "Mock provider isolation"): with
 * `WHATSAPP_PROVIDER=mock` only the mock is constructed — the Meta adapter is
 * never even created, so no `fetch` can fire from `whatsapp` code in tests.
 */
export function createProvider(configService: ConfigService): WhatsAppProvider {
  const providerName = configService.get<string>('WHATSAPP_PROVIDER');

  switch (providerName) {
    case 'mock':
      return new MockWhatsAppProvider();
    case 'meta':
      return new MetaCloudApiProvider(readMetaConfig(configService));
    default:
      throw new Error(
        `Unsupported WHATSAPP_PROVIDER '${providerName ?? '(unset)'}': expected 'mock' or 'meta'`,
      );
  }
}

function readMetaConfig(configService: ConfigService): MetaCloudApiConfig {
  const token = configService.get<string>('WHATSAPP_TOKEN');
  const phoneNumberId = configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
  const wabaId = configService.get<string>('WHATSAPP_WABA_ID');

  const missing = REQUIRED_META_ENV.filter(
    (key) => !configService.get<string>(key),
  );
  if (missing.length > 0) {
    throw new Error(
      `WHATSAPP_PROVIDER=meta requires ${missing.join(', ')} — set them before boot (factory fails fast)`,
    );
  }

  return {
    token: token as string,
    phoneNumberId: phoneNumberId as string,
    wabaId: wabaId as string,
  };
}
