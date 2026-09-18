import { describe, expect, it } from 'vitest';
import { KEYCHAIN_FALLBACK_MESSAGE, providerSaveOutcome } from '../../src/renderer/lib/use-agents';
import type { AgentProviderPublic } from '../../src/shared/schemas';

const input = { baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'secret' };

function saved(keyStorage: AgentProviderPublic['keyStorage']): AgentProviderPublic {
  return { configured: true, baseUrl: input.baseUrl, model: input.model, hasApiKey: keyStorage !== null, keyStorage };
}

describe('providerSaveOutcome', () => {
  it('closes the dialog silently when the key was stored as asked', () => {
    expect(providerSaveOutcome({ ...input, rememberKey: true }, saved('encrypted'))).toEqual({ notice: 'Proveedor del agente guardado de forma segura.' });
    expect(providerSaveOutcome({ ...input, rememberKey: false }, saved('session'))).toEqual({ notice: 'Proveedor del agente configurado para esta sesión.' });
  });

  it('explains a key that stays for the session because macOS refused the keychain', () => {
    const outcome = providerSaveOutcome({ ...input, rememberKey: true }, saved('session'));
    expect(outcome.message).toBe(KEYCHAIN_FALLBACK_MESSAGE);
    expect(outcome.message).toMatch(/reinicia OmniBrowser.*«Permitir siempre»/);
    // Older callers that do not send the flag ask for the key to be remembered.
    expect(providerSaveOutcome(input, saved('session')).message).toBe(KEYCHAIN_FALLBACK_MESSAGE);
  });
});
