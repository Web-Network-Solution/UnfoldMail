import type { Attachment, Email } from '@email-service/shared';

/**
 * Attachments worth showing as files.
 *
 * Inline parts are embedded images referenced by `cid:` in the HTML body — they
 * render inside the message, so listing them as attachments showed a paperclip
 * and a download chip for every logo in every newsletter.
 */
export function visibleAttachments(email: Pick<Email, 'attachments'>): Attachment[] {
  return (email.attachments || []).filter((att) => att.disposition !== 'inline');
}
