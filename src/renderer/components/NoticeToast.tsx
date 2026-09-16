import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export interface NoticeState {
  id: number;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export function NoticeToast({ notice, onClose }: { notice: NoticeState; onClose: () => void }) {
  const Icon = notice.level === 'error' ? AlertCircle : notice.level === 'warning' ? Info : CheckCircle2;
  return (
    <div className={`notice-toast is-${notice.level}`} role={notice.level === 'error' ? 'alert' : 'status'}>
      <Icon size={17} />
      <span>{notice.message}</span>
      <button aria-label="Cerrar aviso" onClick={onClose} type="button"><X size={14} /></button>
    </div>
  );
}
