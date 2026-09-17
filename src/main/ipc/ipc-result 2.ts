import type { z } from 'zod';
import { MAX_URL_LENGTH } from '../../shared/constants';
import { OmniUserError, type IpcResult } from '../../shared/errors';

type Logger = (message: string, error: unknown) => void;

function describeInvalidInput(issues: readonly z.core.$ZodIssue[]): string {
  const issue = issues[0];
  const field = issue?.path[0];
  if (field === 'url') {
    return issue?.code === 'too_big' ? `La URL supera el límite de ${MAX_URL_LENGTH} caracteres.` : 'Introduce una URL válida.';
  }
  if (field === 'name') {
    if (issue?.code === 'too_small') return 'Introduce un nombre para el perfil.';
    if (issue?.code === 'too_big') return 'El nombre del perfil admite como máximo 48 caracteres.';
  }
  return 'La solicitud no es válida.';
}

/** Validates renderer input. Failures become user-facing errors instead of raw Zod issue dumps. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new OmniUserError('invalid-input', describeInvalidInput(result.error.issues));
}

/**
 * Runs an IPC action and always resolves with a serializable result. Expected user errors are returned without logging;
 * anything else is logged once with its stack and reported with a generic message.
 */
export async function runIpcAction<T>(channel: string, action: () => T | Promise<T>, logUnexpected: Logger = console.error): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    if (error instanceof OmniUserError) return { ok: false, error: { code: error.code, message: error.message } };
    logUnexpected(`[omnibrowser] Error inesperado en ${channel}:`, error);
    return { ok: false, error: { code: 'internal', message: 'Se produjo un error inesperado. Consulta el registro de OmniBrowser.' } };
  }
}
