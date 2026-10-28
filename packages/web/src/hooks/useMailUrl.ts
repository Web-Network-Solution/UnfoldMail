import { useCallback, useContext, useEffect, useRef } from 'react';
import { UNSAFE_NavigationContext, useLocation, useNavigate, type Location } from 'react-router-dom';
import type { Folder } from '@email-service/shared';
import { useAuthStore, useMailStore } from '../stores';

type MailState = ReturnType<typeof useMailStore.getState>;
type View = { folder: string | null; email: string | null; thread: string | null };

/** Email and thread ids are UUIDs; anything else is refused before it reaches an API path. */
const ID = /^[\w-]{1,100}$/;

/** Canonical query for a view, and the key both sides are compared by. */
const query = (v: View) => new URLSearchParams(Object.entries(v).filter((e): e is [string, string] => !!e[1])).toString();
const storeView = (s: MailState): View => ({ folder: s.starredView ? 'starred' : s.activeFolderId, email: s.selectedEmailId, thread: s.selectedThreadId });

/**
 * Keeps /mail?folder=<id|starred>&email=<id> (or &thread=<id>) and the mail
 * store in step. A store change pushes a history entry, so Back closes an open
 * message; a URL change (deep link, Back/Forward) is applied to the store. The
 * first inbox pick, a bare /mail and invalid params replace instead. Also picks
 * the inbox once folders load and when the open label disappears.
 *
 * `synced` is the last query both sides agreed on, so neither direction echoes
 * the other. Entries carry the user id in history state: an identity change
 * resets the store (main.tsx), and Back or a reload must not reopen the
 * previous user's message from an old entry.
 *
 * Returns a close for Delete, Move and Mark unread: it replaces the message's
 * entry, so Back does not reopen a message that left the view (and re-mark it read).
 */
export function useMailUrl(folders: Folder[] | undefined, enabled: boolean) {
  const { pathname, search, state, key: at } = useLocation();
  const navigate = useNavigate();
  const history = useContext(UNSAFE_NavigationContext).navigator as { location?: Location };
  const uid = useAuthStore((s) => s.user?.id);
  const storeKey = useMailStore((s) => query(storeView(s)));
  const synced = useRef<string | null>(null);
  const pending = useRef<string | null>(null); // URL folder waiting for the folder list
  const replace = useRef(false);

  useEffect(() => {
    // A navigate() in the same event as a store change (AIAssistant's links) has
    // already moved history, but the router renders it in a transition after the
    // store update. Acting now would push on top of it; its render reruns this.
    if (history.location && history.location.key !== at) return;
    const params = new URLSearchParams(search);
    const url = { folder: params.get('folder'), email: params.get('email'), thread: params.get('thread') };
    const urlKey = query(url);

    if (enabled && urlKey && urlKey !== synced.current) {
      synced.current = urlKey;
      const mark = (state as { mailUser?: string } | null)?.mailUser;
      if (mark && mark !== uid) replace.current = true; // the store's view overwrites it below
      else {
        const email = url.email && ID.test(url.email) ? url.email : null;
        const thread = !email && url.thread && ID.test(url.thread) ? url.thread : null;
        replace.current = !url.folder || email !== url.email || thread !== url.thread;
        useMailStore.setState({ selectedEmailId: email, selectedThreadId: thread });
        pending.current = url.folder;
        if (!mark) navigate({ pathname, search: urlKey }, { replace: true, state: { mailUser: uid } });
      }
    }

    const inbox = folders?.find((f) => f.type === 'inbox');
    if (folders && inbox) {
      const cur = useMailStore.getState(), want = pending.current;
      pending.current = null;
      let folder = folders.find((f) => f.id === (want && want !== 'starred' ? want : cur.activeFolderId));
      if (!folder) { folder = inbox; replace.current = true; }
      const starred = want ? want === 'starred' : cur.starredView;
      if (folder.id !== cur.activeFolderId || starred !== cur.starredView)
        useMailStore.setState({ activeFolderId: folder.id, activeFolder: folder, starredView: starred, page: 1 });
    }

    if (!enabled) { synced.current = null; replace.current = false; return; }
    const s = useMailStore.getState(), key = query(storeView(s));
    if (pending.current || !(s.starredView || s.activeFolderId)) return;
    if (key === urlKey) { replace.current = false; return; }
    navigate({ pathname, search: key }, { replace: !urlKey || replace.current, state: { mailUser: uid } });
    synced.current = key;
    replace.current = false;
  }, [at, search, state, pathname, enabled, uid, folders, storeKey, navigate, history]);

  return useCallback(() => {
    const s = useMailStore.getState();
    if (!s.selectedEmailId) return; // no store change, so the flag would leak into the next pick
    replace.current = true;
    s.setSelectedEmail(null);
  }, []);
}
