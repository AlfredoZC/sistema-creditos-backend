import {
  ProviderSendError,
  ProviderTemplateError,
  metaTemplateErrorMessage,
  truncateErrorMessage,
} from './provider-errors';

describe('provider errors (design §7)', () => {
  describe('ProviderSendError', () => {
    it('carries the meta_http_<status> code and its message', () => {
      const error = new ProviderSendError(
        'meta_http_500',
        'Internal Server Error',
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ProviderSendError');
      expect(error.code).toBe('meta_http_500');
      expect(error.message).toBe('Internal Server Error');
    });

    it('truncates long messages so provider_error stays bounded', () => {
      const longMessage = 'x'.repeat(2000);
      const error = new ProviderSendError('meta_http_400', longMessage);

      expect(error.message.length).toBeLessThan(longMessage.length);
      expect(error.message.startsWith('x'.repeat(100))).toBe(true);
      expect(error.message.endsWith('...')).toBe(true);
    });
  });

  describe('truncateErrorMessage', () => {
    it('keeps short messages as-is', () => {
      expect(truncateErrorMessage('short error')).toBe('short error');
    });

    it('truncates long messages to the limit with a suffix', () => {
      expect(truncateErrorMessage('a'.repeat(1000), 500)).toBe(
        `${'a'.repeat(497)}...`,
      );
    });
  });

  describe('metaTemplateErrorMessage', () => {
    it('maps 131049 to the marketing-mislabel guidance', () => {
      const message = metaTemplateErrorMessage(131049);

      expect(message).toContain('marketing');
      expect(message).toContain('utility');
    });

    it('falls back to a generic message that keeps the unknown code', () => {
      const message = metaTemplateErrorMessage(999999, 'something failed');

      expect(message).toContain('999999');
      expect(message).toContain('something failed');
    });
  });

  describe('ProviderTemplateError', () => {
    it('carries the Meta error code', () => {
      const error = new ProviderTemplateError(131049, 'mislabeled');

      expect(error.name).toBe('ProviderTemplateError');
      expect(error).toBeInstanceOf(Error);
      expect(error.metaCode).toBe(131049);
      expect(error.message).toBe('mislabeled');
    });
  });
});
