import { describe, expect, it, vi } from 'vitest';
import { parseInput, runIpcAction } from '../../src/main/ipc/ipc-result';
import { OmniUserError } from '../../src/shared/errors';
import { assignProfileInputSchema, createProfileInputSchema, layoutBatchSchema, navigateInputSchema, workspaceFileSchema } from '../../src/shared/schemas';
import { InvalidNavigationUrlError } from '../../src/shared/urls';

const browserId = '6c53840e-68e4-4c65-a767-24924cf02a60';

describe('IPC results', () => {
  it('returns expected user errors as data without logging a stack', async () => {
    const log = vi.fn();
    const result = await runIpcAction('omni:browsers:navigate', () => {
      throw new InvalidNavigationUrlError('La entrada no es una URL válida. OmniBrowser no realiza búsquedas implícitas.');
    }, log);
    expect(result).toEqual({ ok: false, error: { code: 'invalid-url', message: 'La entrada no es una URL válida. OmniBrowser no realiza búsquedas implícitas.' } });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs unexpected failures once and returns a generic serializable message', async () => {
    const log = vi.fn();
    const result = await runIpcAction('omni:workspace:save-now', async () => {
      throw new Error('EACCES: permission denied, open /Users/someone/secret');
    }, log);
    expect(result).toEqual({ ok: false, error: { code: 'internal', message: 'Se produjo un error inesperado. Consulta el registro de OmniBrowser.' } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('/Users/someone');
  });

  it('wraps successful values', async () => {
    expect(await runIpcAction('omni:bootstrap', () => 42)).toEqual({ ok: true, value: 42 });
  });
});

describe('IPC input validation', () => {
  it('turns schema violations into localized messages instead of raw Zod issue dumps', () => {
    expect(() => parseInput(navigateInputSchema, { browserId, url: 'x'.repeat(10_000) })).toThrow('La URL supera el límite de 4096 caracteres.');
    expect(() => parseInput(createProfileInputSchema, { name: '   ' })).toThrow('Introduce un nombre para el perfil.');
    expect(() => parseInput(createProfileInputSchema, { name: 'n'.repeat(49) })).toThrow('El nombre del perfil admite como máximo 48 caracteres.');
    expect(() => parseInput(assignProfileInputSchema, { browserId: 'not-a-uuid', profileId: browserId })).toThrow('La solicitud no es válida.');
    try {
      parseInput(navigateInputSchema, { browserId, url: 42 });
    } catch (error) {
      expect(error).toBeInstanceOf(OmniUserError);
      expect((error as OmniUserError).code).toBe('invalid-input');
      expect((error as Error).message).not.toContain('"code"');
    }
  });

  it('rejects prototype-pollution keys from IPC payloads and from workspace files', () => {
    const payload = JSON.parse(`{"browserId":"${browserId}","url":"https://example.com","__proto__":{"polluted":true}}`) as unknown;
    expect(() => parseInput(navigateInputSchema, payload)).toThrow('La solicitud no es válida.');
    const layout = JSON.parse(`{"items":[],"constructor":{"prototype":{"polluted":true}}}`) as unknown;
    expect(() => parseInput(layoutBatchSchema, layout)).toThrow(OmniUserError);
    expect(workspaceFileSchema.safeParse(JSON.parse('{"schemaVersion":1,"__proto__":{"x":1}}')).success).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('bounds the layout batch size and rejects renderer-supplied z-order', () => {
    const item = { browserId, worldRect: { x: 0, y: 0, width: 320, height: 240 }, screenBounds: { x: 0, y: 0, width: 1, height: 1 }, visible: false };
    expect(() => parseInput(layoutBatchSchema, { items: Array.from({ length: 501 }, () => item) })).toThrow(OmniUserError);
    expect(() => parseInput(layoutBatchSchema, { items: [{ ...item, zIndex: 999 }] })).toThrow(OmniUserError);
    expect(parseInput(layoutBatchSchema, { items: [item] }).items).toHaveLength(1);
  });
});
