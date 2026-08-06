import { TemplateCategory } from '../../common/enums';
import { MockWhatsAppProvider } from './mock-whatsapp-provider';
import { ProviderSendError } from './provider-errors';
import {
  SendTemplateMessageInput,
  SubmitTemplateInput,
} from './whatsapp-provider.interface';

function templateInput(to = '+59170000001'): SendTemplateMessageInput {
  return {
    to,
    templateName: 'payment_reminder',
    language: 'es',
    variables: [{ name: '1', value: '8155.19' }],
  };
}

function submitInput(): SubmitTemplateInput {
  return {
    name: 'payment_reminder',
    category: TemplateCategory.UTILITY,
    language: 'es',
    bodyTemplate: 'Tu saldo es {{1}}',
    sampleVariables: { '1': '8155.19' },
  };
}

describe('MockWhatsAppProvider (design §7)', () => {
  let provider: MockWhatsAppProvider;

  beforeEach(() => {
    provider = new MockWhatsAppProvider();
  });

  it('is named mock (runtime mock AND integration fake)', () => {
    expect(provider.name).toBe('mock');
  });

  describe('sendTemplate', () => {
    it('records calls FIFO and returns deterministic wamids', async () => {
      const first = await provider.sendTemplate(templateInput('+59170000001'));
      const second = await provider.sendTemplate(templateInput('+59170000002'));

      expect(first.providerMessageId).toBe('wamid.mock.1');
      expect(second.providerMessageId).toBe('wamid.mock.2');
      expect(provider.sent).toHaveLength(2);
      expect(provider.sent[0].input.to).toBe('+59170000001');
      expect(provider.sent[1].input.to).toBe('+59170000002');
      expect(provider.sent[0].result.providerMessageId).toBe('wamid.mock.1');
    });

    it('preserves the full input in the record for assertions', async () => {
      const input = templateInput();

      await provider.sendTemplate(input);

      expect(provider.sent[0].input).toEqual(input);
    });

    it('rejects once when failNext is set, then recovers for retry tests', async () => {
      provider.failNext = true;

      await expect(
        provider.sendTemplate(templateInput()),
      ).rejects.toBeInstanceOf(ProviderSendError);
      expect(provider.sent).toHaveLength(0);

      const result = await provider.sendTemplate(templateInput());

      expect(result.providerMessageId).toBe('wamid.mock.1');
      expect(provider.sent).toHaveLength(1);
    });
  });

  describe('submitTemplate', () => {
    it('records calls FIFO with deterministic ids and IN_APPROVAL status', async () => {
      const input = submitInput();

      const first = await provider.submitTemplate(input);
      const second = await provider.submitTemplate(input);

      expect(first.providerTemplateId).toBe('template.mock.1');
      expect(first.providerStatus).toBe('IN_APPROVAL');
      expect(second.providerTemplateId).toBe('template.mock.2');
      expect(provider.submitted).toHaveLength(2);
      expect(provider.submitted[0].input).toEqual(input);
      expect(provider.submitted[1].result).toEqual(second);
    });
  });
});
