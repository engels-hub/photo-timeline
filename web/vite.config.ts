import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development the page is served from localhost, so requests to
 * upload.d0b0.lv are cross-site and the browser withholds the `trip_auth`
 * cookie (it is SameSite=Lax) — every photo would come back 403. Proxying them
 * through the dev server makes the images same-origin to the browser, and the
 * cookie is attached here, server side, instead.
 *
 * In production the site is served from a *.d0b0.lv subdomain, where requests
 * are same-site and the browser sends the cookie itself, so no proxy is
 * involved and the photo URLs are used unchanged.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Overridable so the proxy can be pointed at a staging album or a local
  // stand-in without editing this file.
  const target = env.TRIP_ALBUM_ORIGIN || 'https://upload.d0b0.lv';
  const raw = env.TRIP_AUTH_COOKIE ?? '';
  const cookie = raw && !raw.includes('=') ? `trip_auth=${raw}` : raw;

  return {
    plugins: [react()],
    build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
    server: {
      proxy: {
        '/d0b0': {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/d0b0/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (cookie) proxyReq.setHeader('cookie', cookie);
            });
          },
        },
      },
    },
  };
});
