import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Email } from '@email-service/shared';
import { emailApi } from '../lib/api';

export function deliveryLabel(status: Email['deliveryStatus']): string {
  return status ? ({ queued: 'Sending', sending: 'Sending', sent: 'Sent', failed: 'Sending failed', uncertain: 'Delivery needs checking' })[status] : '';
}

export default function DeliveryStatus({ email }: { email: Email }) {
  const client = useQueryClient();
  const refresh = () => {
    for (const key of ['email', 'emails', 'threads', 'thread']) client.invalidateQueries({ queryKey: [key] });
  };
  const resolve = useMutation({ mutationFn: (outcome: 'delivered' | 'not_delivered') => emailApi.resolveDelivery(email.id, outcome), onSuccess: refresh });
  const confirmOutcome = (outcome: 'delivered' | 'not_delivered') => {
    const message = outcome === 'delivered' ? 'Have you confirmed the recipient received this message?' : 'Have you checked provider logs or confirmed with the recipient that this message was not delivered? Retrying a delivered message creates a duplicate.';
    if (window.confirm(message)) resolve.mutate(outcome);
  };
  const retry = useMutation({
    mutationFn: () => emailApi.retry(email.id),
    onSuccess: () => {
      for (const key of ['email', 'emails', 'threads', 'thread']) client.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!email.deliveryStatus || email.deliveryStatus === 'sent') return null;
  return <div role="status" style={{ padding: '12px', background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: 8 }}>
    <strong>{deliveryLabel(email.deliveryStatus)}</strong>
    <p>{email.deliveryStatus === 'queued' || email.deliveryStatus === 'sending'
      ? 'Your email is being sent. You can keep using your mailbox.'
      : email.deliveryError || (email.deliveryStatus === 'failed'
        ? 'Your email could not be sent. Please try again.'
        : 'We could not confirm whether your email was sent. Check before trying again to avoid sending it twice.')}</p>
    {email.deliveryStatus === 'failed' && <button className="btn btn-ghost btn-sm" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry delivery</button>}
    {email.deliveryStatus === 'uncertain' && <div>
      <button className="btn btn-ghost btn-sm" disabled={resolve.isPending} onClick={() => confirmOutcome('delivered')}>Confirm delivered</button>
      <button className="btn btn-ghost btn-sm" disabled={resolve.isPending} onClick={() => confirmOutcome('not_delivered')}>Confirm not delivered</button>
    </div>}
    {resolve.error && <p role="alert">{resolve.error.message}</p>}
    {retry.error && <p role="alert">{retry.error.message}</p>}
  </div>;
}
