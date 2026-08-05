/**
 * Typed provider errors (design §7, AD2). Transport failures and Meta API
 * error bodies are surfaced as `ProviderSendError` (outbound sends) or
 * `ProviderTemplateError` (template submission, Meta error code mapped).
 *
 * Messages are truncated here, at the single choke point, so `provider_error`
 * columns and audit payloads stay bounded.
 */

export const PROVIDER_ERROR_MESSAGE_MAX_LENGTH = 500;

export function truncateErrorMessage(
  message: string,
  maxLength: number = PROVIDER_ERROR_MESSAGE_MAX_LENGTH,
): string {
  if (message.length <= maxLength) {
    return message;
  }
  return `${message.slice(0, Math.max(0, maxLength - 3))}...`;
}

export class ProviderSendError extends Error {
  /**
   * `meta_http_<status>` for non-2xx responses, `meta_timeout` for
   * AbortSignal.timeout, `meta_network` for transport failures,
   * `meta_invalid_response` for unparseable success bodies.
   */
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(truncateErrorMessage(message));
    this.name = 'ProviderSendError';
  }
}

const META_TEMPLATE_ERROR_MESSAGES: Record<number, string> = {
  131049:
    'Template submitted as "marketing" is likely mislabeled (Meta error 131049); reminders must use category "utility"',
};

/**
 * Maps a Meta Graph API error code to a human-readable template-submission
 * message. Unknown codes keep the API message plus the code for traceability.
 */
export function metaTemplateErrorMessage(
  metaCode: number,
  apiMessage?: string,
): string {
  const knownMessage = META_TEMPLATE_ERROR_MESSAGES[metaCode];
  if (knownMessage) {
    return knownMessage;
  }
  return truncateErrorMessage(
    `Meta error ${metaCode}: ${apiMessage ?? 'unknown error'}`,
  );
}

export class ProviderTemplateError extends Error {
  /**
   * `metaCode` is the Meta Graph API error code (-1 when the error body was
   * not a parseable Meta JSON error). 131049 means marketing-mislabel.
   */
  constructor(
    public readonly metaCode: number,
    message: string,
  ) {
    super(truncateErrorMessage(message));
    this.name = 'ProviderTemplateError';
  }
}
