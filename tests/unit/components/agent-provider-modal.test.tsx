// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProviderModal } from '../../../src/renderer/components/AgentProviderModal';

afterEach(() => cleanup());

describe('AgentProviderModal', () => {
  it('never hydrates the stored API key into the renderer and preserves it when saving', async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const onClose = vi.fn();
    render(
      <AgentProviderModal
        isOpen={true}
        onClose={onClose}
        onSave={onSave}
        onTest={vi.fn(async () => ({ ok: true, message: 'Compatible' }))}
        provider={{ configured: true, baseUrl: 'https://api.example.com/v1', model: 'visual-model', hasApiKey: true, keyStorage: 'encrypted' }}
      />
    );

    const apiKey = screen.getByLabelText('Clave API') as HTMLInputElement;
    expect(apiKey.value).toBe('');
    expect(apiKey.placeholder).toContain('conservar la clave guardada');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ baseUrl: 'https://api.example.com/v1', model: 'visual-model', rememberKey: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tests a newly entered OpenAI-compatible provider', async () => {
    const onTest = vi.fn(async () => ({ ok: true, message: 'El proveedor admite respuestas estructuradas.' }));
    render(
      <AgentProviderModal
        isOpen={true}
        onClose={vi.fn()}
        onSave={vi.fn(async () => ({ ok: true }))}
        onTest={onTest}
        provider={{ configured: false, baseUrl: null, model: null, hasApiKey: false, keyStorage: null }}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('gpt-4.1-mini'), { target: { value: 'model-1' } });
    fireEvent.change(screen.getByLabelText('Clave API'), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));

    await waitFor(() => expect(onTest).toHaveBeenCalledWith({
      baseUrl: 'https://api.openai.com/v1',
      model: 'model-1',
      apiKey: 'secret-value'
    }));
    expect(await screen.findByText('El proveedor admite respuestas estructuradas.')).not.toBeNull();
  });

  it('asks for the key again for another provider and keeps failures inside the dialog', async () => {
    const onSave = vi.fn(async () => ({ ok: false, message: 'El proveedor rechazó la prueba (HTTP 401).' }));
    const onClose = vi.fn();
    render(
      <AgentProviderModal
        isOpen={true}
        onClose={onClose}
        onSave={onSave}
        onTest={vi.fn(async () => ({ ok: true, message: 'ok' }))}
        provider={{ configured: true, baseUrl: 'https://api.example.com/v1', model: 'visual-model', hasApiKey: true, keyStorage: 'encrypted' }}
      />
    );
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://other.example/v1' } });
    expect((screen.getByRole('button', { name: 'Guardar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/introdúcela para este endpoint/)).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Clave API'), { target: { value: 'another-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 401');
    expect(onSave).toHaveBeenCalledWith({ baseUrl: 'https://other.example/v1', model: 'visual-model', apiKey: 'another-key', rememberKey: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('explains the macOS password prompt before it appears and can keep the key for this session only', async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    render(
      <AgentProviderModal
        isOpen={true}
        onClose={vi.fn()}
        onSave={onSave}
        onTest={vi.fn(async () => ({ ok: true, message: 'ok' }))}
        provider={{ configured: false, baseUrl: null, model: null, hasApiKey: false, keyStorage: null }}
      />
    );
    const remember = screen.getByRole('checkbox', { name: 'Recordar la clave en este Mac' }) as HTMLInputElement;
    expect(remember.checked).toBe(true);
    expect(screen.getByText(/macOS puede pedir la contraseña de tu Mac: la recibe macOS, no OmniBrowser\. Elige «Permitir siempre»/)).not.toBeNull();

    fireEvent.click(remember);
    expect(remember.checked).toBe(false);
    expect(screen.getByText(/macOS no pedirá ninguna contraseña/)).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText('gpt-4.1-mini'), { target: { value: 'model-1' } });
    fireEvent.change(screen.getByLabelText('Clave API'), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Usar en esta sesión' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ baseUrl: 'https://api.openai.com/v1', model: 'model-1', apiKey: 'secret-value', rememberKey: false }));
  });

  it('keeps the explanation on screen when macOS refused the keychain and the key only lasts this session', async () => {
    const message = 'macOS no permitió guardar la clave en el llavero, así que el agente la usará solo hasta que cierres OmniBrowser.';
    const onClose = vi.fn();
    const { rerender } = render(
      <AgentProviderModal
        isOpen={true}
        onClose={onClose}
        onSave={vi.fn(async () => ({ ok: true, message }))}
        onTest={vi.fn(async () => ({ ok: true, message: 'ok' }))}
        provider={{ configured: false, baseUrl: null, model: null, hasApiKey: false, keyStorage: null }}
      />
    );
    fireEvent.change(screen.getByPlaceholderText('gpt-4.1-mini'), { target: { value: 'model-1' } });
    fireEvent.change(screen.getByLabelText('Clave API'), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    expect((await screen.findByRole('status')).textContent).toContain(message);
    // The saved provider arrives while the explanation is shown; it must not reset the dialog.
    rerender(
      <AgentProviderModal
        isOpen={true}
        onClose={onClose}
        onSave={vi.fn(async () => ({ ok: true }))}
        onTest={vi.fn(async () => ({ ok: true, message: 'ok' }))}
        provider={{ configured: true, baseUrl: 'https://api.openai.com/v1', model: 'model-1', hasApiKey: true, keyStorage: 'session' }}
      />
    );
    expect(screen.getByRole('status').textContent).toContain(message);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Listo' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says when the active key only lasts this session', () => {
    render(
      <AgentProviderModal
        isOpen={true}
        onClose={vi.fn()}
        onSave={vi.fn(async () => ({ ok: true }))}
        onTest={vi.fn(async () => ({ ok: true, message: 'ok' }))}
        provider={{ configured: true, baseUrl: 'https://api.example.com/v1', model: 'visual-model', hasApiKey: true, keyStorage: 'session' }}
      />
    );
    expect(screen.getByText(/Hay una clave activa solo en esta sesión/)).not.toBeNull();
    expect((screen.getByLabelText('Clave API') as HTMLInputElement).placeholder).toBe('Dejar en blanco para conservar la clave de esta sesión');
    expect((screen.getByRole('checkbox', { name: 'Recordar la clave en este Mac' }) as HTMLInputElement).checked).toBe(false);
  });
});
