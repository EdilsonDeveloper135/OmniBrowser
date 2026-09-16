export type OmniErrorCode = 'invalid-input' | 'invalid-url' | 'not-found' | 'conflict' | 'forbidden' | 'internal';

/**
 * An expected, user-facing failure. Its message is shown verbatim in the shell and it is never logged with a stack.
 */
export class OmniUserError extends Error {
  readonly code: OmniErrorCode;

  constructor(code: OmniErrorCode, message: string) {
    super(message);
    this.name = 'OmniUserError';
    this.code = code;
  }
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: OmniErrorCode; message: string } };
