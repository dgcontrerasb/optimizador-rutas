import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

function getLocalApiKey(): string {
  try {
    const envLocalPath = path.resolve(process.cwd(), '.env.local');
    if (fs.existsSync(envLocalPath)) {
      const content = fs.readFileSync(envLocalPath, 'utf-8');
      const match = content.match(/VITE_GOOGLE_MAPS_API_KEY=["']?([^"'\r\n]+)["']?/);
      if (match && match[1]) return match[1].trim();
    }
  } catch {}
  return '';
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  const googleMapsApiKey = getLocalApiKey() || env.VITE_GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '';

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'inject-app-runtime-config',
        transformIndexHtml(html) {
          const configScript = `<script>window.__APP_CONFIG__ = Object.freeze({ GOOGLE_MAPS_API_KEY: ${JSON.stringify(googleMapsApiKey)} });</script>`;
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
