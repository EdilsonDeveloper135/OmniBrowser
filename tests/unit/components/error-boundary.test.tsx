// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../../src/renderer/components/ErrorBoundary';

afterEach(() => {
  cleanup();
});

function CrashingComponent({ shouldCrash }: { shouldCrash: boolean }) {
  if (shouldCrash) {
    throw new Error('Explosión simulada en render');
  }
  return <div>Contenido normal</div>;
}

describe('ErrorBoundary component', () => {
  it('renders children normally when there is no error', () => {
    render(
      <ErrorBoundary>
        <CrashingComponent shouldCrash={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Contenido normal')).not.toBeNull();
  });

  it('renders fallback error UI when a child throws during render', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <CrashingComponent shouldCrash={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('OmniBrowser encontró un error inesperado')).not.toBeNull();
    expect(screen.getByText('Explosión simulada en render')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Recargar' })).not.toBeNull();

    consoleError.mockRestore();
  });
});
