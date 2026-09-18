// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptModal } from '../../../src/renderer/components/PromptModal';

afterEach(() => {
  cleanup();
});

describe('PromptModal component', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <PromptModal
        isOpen={false}
        title="Test Modal"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders title, description and input when isOpen is true', () => {
    render(
      <PromptModal
        isOpen={true}
        title="Crear nueva zona"
        description="Asigna un nombre a la zona"
        placeholder="Nombre de la zona"
        defaultValue="Zona 1"
        confirmLabel="Crear"
        cancelLabel="Cancelar"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(screen.getByText('Crear nueva zona')).not.toBeNull();
    expect(screen.getByText('Asigna un nombre a la zona')).not.toBeNull();
    const input = screen.getByPlaceholderText('Nombre de la zona') as HTMLInputElement;
    expect(input.value).toBe('Zona 1');
  });

  it('calls onConfirm with trimmed text on submit', () => {
    const handleConfirm = vi.fn();
    render(
      <PromptModal
        isOpen={true}
        title="Nombre"
        defaultValue=""
        confirmLabel="Guardar"
        onConfirm={handleConfirm}
        onCancel={vi.fn()}
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  Mi Zona de Trabajo  ' } });

    const submitBtn = screen.getByRole('button', { name: 'Guardar' });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submitBtn);
    expect(handleConfirm).toHaveBeenCalledTimes(1);
    expect(handleConfirm).toHaveBeenCalledWith('Mi Zona de Trabajo');
  });

  it('disables confirm button when input contains only whitespace', () => {
    render(
      <PromptModal
        isOpen={true}
        title="Nombre"
        defaultValue="   "
        confirmLabel="Guardar"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const submitBtn = screen.getByRole('button', { name: 'Guardar' });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onCancel when cancel button is clicked', () => {
    const handleCancel = vi.fn();
    render(
      <PromptModal
        isOpen={true}
        title="Nombre"
        cancelLabel="Descartar"
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(handleCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape key is pressed', () => {
    const handleCancel = vi.fn();
    render(
      <PromptModal
        isOpen={true}
        title="Nombre"
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />
    );

    fireEvent.keyDown(screen.getByRole('presentation'), { key: 'Escape' });
    expect(handleCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when backdrop is clicked directly', () => {
    const handleCancel = vi.fn();
    render(
      <PromptModal
        isOpen={true}
        title="Nombre"
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />
    );

    const backdrop = screen.getByRole('presentation');
    fireEvent.click(backdrop);
    expect(handleCancel).toHaveBeenCalledTimes(1);
  });

  it('includes native-occluder class on backdrop so Chromium views do not cover it', () => {
    render(
      <PromptModal
        isOpen={true}
        title="Zona"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const backdrop = screen.getByRole('presentation');
    expect(backdrop.classList.contains('native-occluder')).toBe(true);
    expect(backdrop.classList.contains('modal-backdrop')).toBe(true);
  });

  it('dismisses modal on global window Escape keydown event', () => {
    const handleCancel = vi.fn();
    render(
      <PromptModal
        isOpen={true}
        title="Zona"
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handleCancel).toHaveBeenCalledTimes(1);
  });
});
