import { describe, expect, it } from 'vitest';
import { userFacingError } from '../../src/renderer/lib/errors';

describe('userFacingError', () => {
  it('removes Electron IPC implementation details from validation messages', () => {
    expect(userFacingError(new Error(
      "Error invoking remote method 'omni:browsers:navigate': InvalidNavigationUrlError: El protocolo javascript: no está permitido."
    ))).toBe('El protocolo javascript: no está permitido.');
  });

  it('preserves ordinary errors', () => {
    expect(userFacingError(new Error('No se pudo guardar el workspace.'))).toBe('No se pudo guardar el workspace.');
  });
});
