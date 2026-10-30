/** One problem+json error (API doc section 1, Errors). `errors` and `current` only when they apply. */
export interface FieldError {
  path: string;
  code: string;
  message: string;
}

const TITLES: Record<string, string> = {
  bad_request: 'The request is malformed',
  bad_cursor: 'The page cursor is not valid',
  bad_filter: 'A filter is not valid',
  unauthenticated: 'Sign in to continue',
  session_expired: 'Your session has ended; sign in again',
  forbidden: 'You may not do this',
  field_forbidden: 'You may not change some of these fields',
  csrf_header_missing: 'The request is missing its X-Requested-With header',
  not_found: 'Not found',
  version_conflict: 'Someone else changed this first',
  duplicate: 'This already exists',
  managed_by_entra: 'This membership comes from Microsoft Entra',
  cursor_expired: 'The offline copy is too old; reload it',
  payload_too_large: 'The request is too large',
  validation_failed: 'Some fields are not valid',
  idempotency_key_reused: 'This Idempotency-Key was used for a different request',
  version_required: 'Send If-Match with the version you edited',
  internal: 'Something went wrong on the server',
  unavailable: 'The service is unavailable',
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly extra: { errors?: FieldError[]; current?: unknown } = {},
  ) {
    super(detail);
  }

  body(requestId: string) {
    return {
      type: `https://launch-tracker.internal/errors/${this.code}`,
      title: TITLES[this.code] ?? this.code,
      status: this.status,
      code: this.code,
      detail: this.detail,
      requestId,
      ...this.extra,
    };
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} does not exist, or you may not see it.`);
export const forbidden = (detail: string) => new ApiError(403, 'forbidden', detail);
export const invalid = (errors: FieldError[]) =>
  new ApiError(422, 'validation_failed', errors.length === 1 ? (errors[0]?.message ?? '') : `${errors.length} fields are not valid.`, { errors });
