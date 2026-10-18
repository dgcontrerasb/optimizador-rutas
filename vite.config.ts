import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  const googleMapsApiKey = env.VITE_GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '';

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
