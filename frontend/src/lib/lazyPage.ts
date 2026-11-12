import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Set for one tab session once a failed page download has already caused a reload. */
const RELOAD_FLAG = 'rankvora.chunk-reload';

/**
 * `React.lazy` for a route's page, with one safety net.
 *
 * Every deploy renames the built files (their names carry a hash of their content), so a tab opened
 * before the deploy asks for a page file that no longer exists and the import fails. Without this the
 * merchant lands on the "Something went wrong" screen for a perfectly healthy app. Here the first
 * such failure reloads the page once, which fetches the new index.html and the new file names; a
 * second failure in the same session (a real outage, or the network being down) is thrown as usual so
 * ErrorBoundary can show it instead of looping.
 */
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const page = await load();
      try { window.sessionStorage.removeItem(RELOAD_FLAG); } catch { /* storage blocked: nothing to reset */ }
      return page;
    } catch (error) {
      let alreadyReloaded = true;
      try {
        alreadyReloaded = window.sessionStorage.getItem(RELOAD_FLAG) === '1';
        if (!alreadyReloaded) window.sessionStorage.setItem(RELOAD_FLAG, '1');
      } catch { /* storage blocked: never reload, so it cannot loop */ }
      if (!alreadyReloaded) {
        window.location.reload();
        // The page is going away; hold the render until it does rather than flashing the error screen.
        return new Promise<never>(() => undefined);
      }
      throw error;
    }
  });
}
