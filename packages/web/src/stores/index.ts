/**
 * Global application store using Zustand.
 * Auth state, active folder, selection, compose state, toasts and theme.
 */
import { create } from 'zustand';
import type { Email, Folder, User } from '@email-service/shared';

// ─── Auth Store ───────────────────────────────────────────────────

const IMPERSONATION_KEY = 'impersonation';

interface ImpersonationData {
  originalUserEmail: string;
  targetEmail: string;
}

function getImpersonation(): ImpersonationData | null {
  try {
    const raw = localStorage.getItem(IMPERSONATION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setImpersonation(data: ImpersonationData | null) {
  try {
    if (data) {
      localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(data));
    } else {
      localStorage.removeItem(IMPERSONATION_KEY);
    }
  } catch {
    // Non-fatal.
  }
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isImpersonating: boolean;
  impersonatingEmail: string;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  startImpersonation: (targetEmail: string, originalUserEmail: string) => void;
  stopImpersonation: () => void;
}

const savedImpersonation = getImpersonation();

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isImpersonating: !!savedImpersonation,
  impersonatingEmail: savedImpersonation?.targetEmail || '',
  setUser: (user) => set({ user, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
  startImpersonation: (targetEmail, originalUserEmail) => {
    setImpersonation({ originalUserEmail, targetEmail });
    set({ isImpersonating: true, impersonatingEmail: targetEmail });
  },
  stopImpersonation: () => {
    setImpersonation(null);
    set({ isImpersonating: false, impersonatingEmail: '' });
  },
}));

// ─── Mail Store ───────────────────────────────────────────────────

export type MailView = 'messages' | 'threads';

interface MailState {
  activeFolderId: string | null;
  activeFolder: Folder | null;
  selectedEmailId: string | null;
  selectedThreadId: string | null;
  view: MailView;
  page: number;
  /** True when viewing the virtual "Starred" list. */
  starredView: boolean;
  isComposeOpen: boolean;
  /** Bumped on every open so the modal remounts with fresh state. */
  composeSession: number;
  composeReplyTo: Email | null;
  composeReplyAll: boolean;
  composeForward: Email | null;
  composeDraft: Email | null;
  composeTo: string;

  setActiveFolder: (folder: Folder, preserveSelection?: boolean) => void;
  setSelectedEmail: (emailId: string | null) => void;
  setSelectedThread: (threadId: string | null) => void;
  setStarredView: (on: boolean) => void;
  setView: (view: MailView) => void;
  setPage: (page: number) => void;
  openCompose: (options?: {
    replyTo?: Email;
    replyAll?: boolean;
    forward?: Email;
    draft?: Email;
    to?: string;
  }) => void;
  closeCompose: () => void;
}

export const useMailStore = create<MailState>((set) => ({
  activeFolderId: null,
  activeFolder: null,
  selectedEmailId: null,
  selectedThreadId: null,
  view: 'messages',
  page: 1,
  starredView: false,
  isComposeOpen: false,
  composeSession: 0,
  composeReplyTo: null,
  composeReplyAll: false,
  composeForward: null,
  composeDraft: null,
  composeTo: '',

  setActiveFolder: (folder, preserveSelection = false) =>
    set({
      activeFolderId: folder.id,
      activeFolder: folder,
      ...(!preserveSelection ? { selectedEmailId: null, selectedThreadId: null } : {}),
      starredView: false,
      page: 1,
    }),
  setSelectedEmail: (selectedEmailId) => set({ selectedEmailId, selectedThreadId: null }),
  setSelectedThread: (selectedThreadId) => set({ selectedThreadId, selectedEmailId: null }),
  setStarredView: (starredView) =>
    set({ starredView, selectedEmailId: null, selectedThreadId: null, page: 1 }),
  setView: (view) => set({ view, selectedEmailId: null, selectedThreadId: null, page: 1 }),
  setPage: (page) => set({ page }),
  openCompose: (options) =>
    set((state) => ({
      isComposeOpen: true,
      composeSession: state.composeSession + 1,
      composeReplyTo: options?.replyTo || null,
      composeReplyAll: options?.replyAll || false,
      composeForward: options?.forward || null,
      composeDraft: options?.draft || null,
      composeTo: options?.to || '',
    })),
  closeCompose: () =>
    set({
      isComposeOpen: false,
      composeReplyTo: null,
      composeReplyAll: false,
      composeForward: null,
      composeDraft: null,
    }),
}));

// ─── Toast Store ──────────────────────────────────────────────────

export interface Toast {
  id: string;
  type: 'info' | 'success' | 'error' | 'new_email';
  title: string;
  body?: string;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => string;
  updateToast: (id: string, toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

let toastSeq = 0;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleToastRemoval(id: string, duration = 5000) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  if (duration > 0) toastTimers.set(id, setTimeout(() => useToastStore.getState().removeToast(id), duration));
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${++toastSeq}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));

    scheduleToastRemoval(id, toast.duration);
    return id;
  },
  updateToast: (id, toast) => {
    set((state) => ({ toasts: state.toasts.map(t => t.id === id ? { ...toast, id } : t) }));
    scheduleToastRemoval(id, toast.duration);
  },
  removeToast: (id) => {
    clearTimeout(toastTimers.get(id));
    toastTimers.delete(id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

// ─── Theme Store ──────────────────────────────────────────────────

type Theme = 'dark' | 'light';
const THEME_KEY = 'mail-theme';

/**
 * Read once at module load. index.html applies the same value before first
 * paint, so the app does not flash the wrong theme, and the choice survives a
 * reload — previously it reset to dark every time.
 */
function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage can be unavailable (private mode, blocked cookies).
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Non-fatal.
  }
}

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme(),
  toggleTheme: () =>
    set((state) => {
      const theme: Theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(theme);
      return { theme };
    }),
}));

applyTheme(useThemeStore.getState().theme);

/** Shared connection health drives polling fallback in mounted mailbox views. */
export const useRealtimeStore = create<{ connected: boolean; setConnected: (connected: boolean) => void }>((set) => ({
  connected: false, setConnected: (connected) => set({ connected }),
}));
