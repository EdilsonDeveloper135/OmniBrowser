// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChatPanel, type AgentChatPanelProps } from '../../../src/renderer/components/AgentChatPanel';
import type { AgentChatSnapshot, AgentSummary } from '../../../src/shared/schemas';

afterEach(() => cleanup());

const summary: AgentSummary = {
  browserId: 'browser-1',
  agentId: 'agent-1',
  chatSessionId: 'chat-1',
  state: 'running',
  activeTaskId: 'task-1',
  queuedTaskCount: 1,
  sequence: 4,
  updatedAt: '2026-01-01T00:00:04.000Z',
  requiresProvider: false
};

const snapshot: AgentChatSnapshot = {
  summary,
  conversationSummary: '',
  messages: [
    { id: 'message-1', role: 'user', content: 'Busca la documentación', createdAt: '2026-01-01T00:00:01.000Z', taskId: 'task-1' },
    { id: 'message-2', role: 'assistant', content: 'Estoy revisando la página.', createdAt: '2026-01-01T00:00:02.000Z', taskId: 'task-1' }
  ],
  tasks: [{
    id: 'task-1',
    instruction: 'Busca la documentación',
    state: 'running',
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:04.000Z',
    startedAt: '2026-01-01T00:00:02.000Z',
    completedAt: null,
    outcome: null
  }],
  timeline: [{
    id: 'event-1',
    browserId: 'browser-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    runId: 'run-1',
    sequence: 4,
    kind: 'action',
    level: 'info',
    summary: 'Inspeccionó la página actual',
    createdAt: '2026-01-01T00:00:04.000Z'
  }]
};

function createProps(overrides: Partial<AgentChatPanelProps> = {}): AgentChatPanelProps {
  return {
    browserId: 'browser-1',
    summary,
    snapshot,
    onClose: vi.fn(),
    onOpenSettings: vi.fn(),
    onSend: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    ...overrides
  };
}

describe('AgentChatPanel', () => {
  it('renders messages, timeline, status and task controls', () => {
    const props = createProps();
    render(<AgentChatPanel {...props} />);

    expect(screen.getByText('Ejecutando')).not.toBeNull();
    expect(screen.getByText('Busca la documentación')).not.toBeNull();
    expect(screen.getByText('Estoy revisando la página.')).not.toBeNull();
    expect(screen.getByText('Inspeccionó la página actual')).not.toBeNull();
    expect(screen.getByText('1 en cola')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pausar agente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Detener agente y cancelar su cola' }));
    expect(props.onPause).toHaveBeenCalledTimes(1);
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it('submits a trimmed instruction and supports closing and settings', () => {
    const props = createProps();
    render(<AgentChatPanel {...props} />);
    const composer = screen.getByLabelText('Instrucción para el agente');

    fireEvent.change(composer, { target: { value: '  Abre el primer resultado  ' } });
    fireEvent.submit(composer.closest('form')!);
    expect(props.onSend).toHaveBeenCalledWith('Abre el primer resultado');
    expect((composer as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Configurar proveedor del agente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar panel del agente' }));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the provider-required empty state and prevents sending', () => {
    const props = createProps({
      summary: { ...summary, state: 'idle', activeTaskId: null, queuedTaskCount: 0, requiresProvider: true },
      snapshot: null
    });
    render(<AgentChatPanel {...props} />);

    expect(screen.getByText('Configura un proveedor')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Abrir configuración' })).not.toBeNull();
    expect((screen.getByLabelText('Instrucción para el agente') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Enviar instrucción' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers Resume while paused and surfaces public errors', () => {
    const props = createProps({ summary: { ...summary, state: 'paused' }, error: 'El target fue destruido.' });
    render(<AgentChatPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reanudar agente' }));
    expect(props.onResume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('El target fue destruido.');
  });

  it('shows activity between the messages it happened between', () => {
    const { container } = render(<AgentChatPanel {...createProps({
      snapshot: {
        ...snapshot,
        timeline: [{ ...snapshot.timeline[0]!, createdAt: '2026-01-01T00:00:01.500Z' }]
      }
    })} />);
    const history = [...container.querySelectorAll('.agent-history > article, .agent-history > .agent-timeline-event')].map((element) => element.textContent);
    expect(history).toEqual(['TúBusca la documentación', 'Inspeccionó la página actual', 'AgenteEstoy revisando la página.']);
  });

  it('does not send while an input method is composing and queues when the agent is busy', () => {
    const props = createProps();
    render(<AgentChatPanel {...props} />);
    const composer = screen.getByLabelText('Instrucción para el agente');
    fireEvent.change(composer, { target: { value: 'にほん' } });
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Se añadirá a la cola de esta tarjeta')).not.toBeNull();
  });

  it('knows the provider state before the card has an agent and can pause a waiting queue', () => {
    const { rerender } = render(<AgentChatPanel {...createProps({ summary: null, snapshot: null, providerReady: false })} />);
    expect(screen.getByText('Configura un proveedor')).not.toBeNull();
    rerender(<AgentChatPanel {...createProps({ summary: null, snapshot: null, providerReady: true })} />);
    expect(screen.queryByText('Configura un proveedor')).toBeNull();
    expect((screen.getByLabelText('Instrucción para el agente') as HTMLTextAreaElement).disabled).toBe(false);

    const props = createProps({ summary: { ...summary, state: 'queued' } });
    rerender(<AgentChatPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pausar agente' }));
    expect(props.onPause).toHaveBeenCalledTimes(1);
  });
});
