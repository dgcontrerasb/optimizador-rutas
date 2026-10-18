# 🚚 RutasJamar — Planificador de Rutas de Entrega

Sistema web para organizar, agrupar y optimizar rutas de camiones de entrega en Bogotá y municipios cercanos, saliendo desde **Cendis Siberia**.

---

## 📌 ¿Qué hace este proyecto?

- **Lee archivos de Excel:** Carga la lista de pedidos del día con sus direcciones y cantidades.
- **Ubica en el mapa:** Geocodifica y encuentra las direcciones de los clientes en Bogotá y la Sabana usando mapas interactivos.
- **Arma las rutas automáticamente:** Agrupa los pedidos por zonas para que los camiones no se crucen y aprovechen al máximo su capacidad.
- **Descarga reportes:** Genera listas en Excel, PDF y CSV para entregárselas a los conductores.

---

## 🛠️ Tecnologías utilizadas

- **React y Vite:** Para la interfaz rápida y moderna de la página web.
- **Tailwind CSS:** Para el diseño visual.
- **Leaflet y Google Maps:** Para visualizar el mapa y buscar las direcciones.
- **SheetJS y jsPDF:** Para leer archivos Excel y exportar reportes en PDF.

---

## 🔒 Seguridad

- No se guardan contraseñas ni claves privadas dentro de este código.
- Las claves de mapas se configuran de manera segura y privada al publicar la aplicación.
