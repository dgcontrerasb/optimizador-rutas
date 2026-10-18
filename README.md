# 🚚 RutasJamar — Planificador Logístico de Rutas (Bogotá y Sabana)

Sistema de planificación, consolidación espacial, zonificación elástica y optimización de rutas de última milla desde **Cendis Siberia**, con visualización interactiva en mapa, cálculo vial real (OSRM) y exportación operativa completa.

---

## 🔒 Seguridad y Protección de Datos Sensibles

Este repositorio está configurado para **no exponer ninguna clave API ni datos sensibles de clientes**:

1. **Sin API Keys en el código fuente**: La clave de Google Maps se lee exclusivamente a través de la variable de entorno `VITE_GOOGLE_MAPS_API_KEY`.
2. **Protección en `.gitignore`**:
   - Todos los archivos `.env`, `.env.local` y `*.local` están bloqueados.
   - La carpeta interna `.aistudio/` y `.vercel/` están excluidas.
   - Los archivos Excel y CSV (`*.xlsx`, `*.xls`, `*.csv`) están bloqueados por defecto para evitar subir accidentalmente listados con nombres, cédulas, teléfonos o direcciones de clientes a GitHub.

---

## 💻 Ejecución en Desarrollo Local

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Crea un archivo `.env.local` en la raíz del proyecto (puedes basarte en `.env.example`):
   ```env
   VITE_GOOGLE_MAPS_API_KEY="TU_CLAVE_DE_GOOGLE_MAPS"
   ```
   *(Si se omite, el sistema funcionará automáticamente con los motores abiertos de geocodificación de respaldo).*
3. Inicia el servidor de desarrollo:
   ```bash
   npm run dev
   ```

---

## 🚀 Guía Paso a Paso: Subir a GitHub y Desplegar en Vercel

### Paso 1: Subir el proyecto a GitHub
1. Inicializa el repositorio Git en la carpeta del proyecto (si aún no lo has hecho):
   ```bash
   git init
   git add .
   ```
2. Verifica con `git status` que **no** aparezcan archivos `.env.local`, `.aistudio/` ni archivos `.xlsx`:
   ```bash
   git status
   ```
3. Crea el commit y súbelo a tu repositorio de GitHub:
   ```bash
   git commit -m "chore: preparar proyecto seguro para produccion en Vercel"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git
   git push -u origin main
   ```

### Paso 2: Desplegar en Vercel
1. Ingresa a [vercel.com](https://vercel.com/) e inicia sesión con tu cuenta de GitHub.
2. Haz clic en **"Add New..." → "Project"** e importa tu repositorio.
3. En la sección **Framework Preset**, Vercel detectará automáticamente **Vite** gracias al archivo `vercel.json` (`Build Command: npm run build`, `Output Directory: dist`).
4. Abre la sección **Environment Variables** antes de desplegar y agrega:
   - **Key**: `VITE_GOOGLE_MAPS_API_KEY`
   - **Value**: *(Pega aquí tu clave `AIzaSy...` de Google Maps)*
   - **Environments**: Marca *Production*, *Preview* y *Development*.
5. Haz clic en **Deploy**.

### Paso 3: Recomendación de Seguridad en Google Cloud Console
Dado que el SDK de Google Maps se ejecuta en el navegador del despachador, restringe tu API Key en [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials):
- **Application restrictions**: Selecciona **Websites (HTTP referrers)** y agrega únicamente tu dominio de Vercel (`https://tu-proyecto.vercel.app/*`).
- **API restrictions**: Limita la clave exclusivamente a *Maps JavaScript API*, *Geocoding API* y *Places API*.
