import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

function getLocalEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const envLocalPath = path.resolve(process.cwd(), '.env.local');
    if (fs.existsSync(envLocalPath)) {
      const content = fs.readFileSync(envLocalPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) {
          const k = m[1].trim();
          const v = m[2].trim().replace(/^["']|["']$/g, '');
          result[k] = v;
        }
      }
    }
  } catch {}
  return result;
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  const localEnv = getLocalEnv();
  const googleMapsApiKey = localEnv.VITE_GOOGLE_MAPS_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const authUserHash = localEnv.VITE_AUTH_USER_HASH || env.VITE_AUTH_USER_HASH || process.env.VITE_AUTH_USER_HASH || 'f9ccd79a0dd81ac1350e821257dab0e95ba26f583852321572ea71fa47847227';
  const authPassHash = localEnv.VITE_AUTH_PASS_HASH || env.VITE_AUTH_PASS_HASH || process.env.VITE_AUTH_PASS_HASH || 'c6c2f79d92bbfcb8caf4f430f59ec0fe4eaec0c91185a414beab55b98541f0f1';

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'inject-app-runtime-config',
        transformIndexHtml(html) {
          const encodedKey = googleMapsApiKey ? Buffer.from(googleMapsApiKey.trim()).toString('base64') : '';
          const configScript = `<script>window.__APP_CONFIG__ = Object.freeze({ GOOGLE_MAPS_API_KEY: ${JSON.stringify(encodedKey)}, AUTH_USER_HASH: ${JSON.stringify(authUserHash)}, AUTH_PASS_HASH: ${JSON.stringify(authPassHash)} });</script>`;
          return html.replace('</head>', `  ${configScript}\n</head>`);
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      sourcemap: false,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
