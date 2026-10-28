/**
 * PWA Registration & Install Management Helper
 */

// Interface for beforeinstallprompt event
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<(canInstall: boolean) => void>();

export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  // Register on window load to not block initial render
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        console.log('[PWA] Service Worker registered with scope:', reg.scope);

        // Check for updates periodically
        setInterval(() => {
          reg.update().catch(() => {});
        }, 60 * 60 * 1000); // Hourly check

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('[PWA] New version available!');
              }
            });
          }
        });
      })
      .catch((err) => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
  });

  // Capture install prompt event
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e as BeforeInstallPromptEvent;
    notifyInstallListeners(true);
  });

  window.addEventListener('appinstalled', () => {
    console.log('[PWA] App installed successfully');
    deferredInstallPrompt = null;
    notifyInstallListeners(false);
  });
}

function notifyInstallListeners(canInstall: boolean) {
  installListeners.forEach((fn) => fn(canInstall));
}

export function subscribeInstallState(callback: (canInstall: boolean) => void): () => void {
  installListeners.add(callback);
  callback(!!deferredInstallPrompt);
  return () => {
    installListeners.delete(callback);
  };
}

export async function promptInstallApp(): Promise<boolean> {
  if (!deferredInstallPrompt) {
    return false;
  }

  try {
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      deferredInstallPrompt = null;
      notifyInstallListeners(false);
      return true;
    }
  } catch (err) {
    console.warn('[PWA] Install prompt error:', err);
  }

  return false;
}

export function isRunningStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
    document.referrer.includes('android-app://')
  );
}
