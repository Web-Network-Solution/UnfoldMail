import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ApiError } from './lib/api';
import { registerServiceWorker } from './lib/pwa';
import { useAuthStore, useMailStore } from './stores';
import './styles/index.css';
import './styles/components.css';
import './styles/productivity.css';
import './styles/controls.css';

// Register Service Worker for PWA
registerServiceWorker();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Retrying a 401/403/404 just delays the error the user needs to see.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

// Sign-out, an expired session and impersonation all go through setUser. On any
// identity change drop the previous user's cached mail and selection before the
// next user's views render, so none of it flashes up in their session.
useAuthStore.subscribe((state, prev) => {
  if (!prev.user || prev.user.id === state.user?.id) return;
  queryClient.clear();
  useMailStore.setState(useMailStore.getInitialState());
});

// A deploy replaces the hashed chunks, so a long-open tab fails to lazy-load one
// it never fetched. Reload once for the new build; the timestamp stops a loop.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem('chunk-reload') || 0) < 10_000) return;
    sessionStorage.setItem('chunk-reload', String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
