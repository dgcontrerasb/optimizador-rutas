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
  const firebaseDatabaseUrl = localEnv.VITE_FIREBASE_DATABASE_URL || env.VITE_FIREBASE_DATABASE_URL || process.env.VITE_FIREBASE_DATABASE_URL || '';
  const firebaseAuthSecret = localEnv.VITE_FIREBASE_AUTH_SECRET || env.VITE_FIREBASE_AUTH_SECRET || process.env.VITE_FIREBASE_AUTH_SECRET || '';

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'inject-app-runtime-config',
        transformIndexHtml(html) {
          const configScript = `<script>window.__APP_CONFIG__ = Object.freeze({ GOOGLE_MAPS_API_KEY: ${JSON.stringify(googleMapsApiKey)}, FIREBASE_DATABASE_URL: ${JSON.stringify(firebaseDatabaseUrl)}, FIREBASE_AUTH_SECRET: ${JSON.stringify(firebaseAuthSecret)} });</script>`;
          return html.replace('</head>', `  ${configScript}\n</head>`);
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
