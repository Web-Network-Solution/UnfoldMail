import { useToastStore } from '../stores';
import type { Toast } from '../stores';
import { IconNewMail, IconCheckCircle, IconAlertCircle } from './Icons';

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast: Toast) => (
        <div
          key={toast.id}
          role={toast.type === 'error' ? 'alert' : 'status'}
          className={`toast ${toast.type === 'new_email' ? 'toast-new-email' : ''}`}
          onClick={() => removeToast(toast.id)}
          style={{ cursor: 'pointer' }}
        >
          <div>
            <div className="toast-title">
              {toast.type === 'new_email' && <><IconNewMail size={16} />{' '}</>}
              {toast.type === 'success' && <><IconCheckCircle size={16} color="var(--color-success)" />{' '}</>}
              {toast.type === 'error' && <><IconAlertCircle size={16} color="var(--color-error)" />{' '}</>}
              {toast.title}
            </div>
            {toast.body && <div className="toast-body">{toast.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
