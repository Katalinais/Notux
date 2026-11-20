# Notux

PWA para organizar tareas, notas y (próximamente) el calendario y el horario semanal. Funciona sin conexión y guarda todo en el navegador: no hay servidor ni cuentas.

## Funcionalidades

- **Tareas**: título, fecha límite y prioridad; editar, eliminar con opción de deshacer, búsqueda, filtro por prioridad y marcar en bloque como hechas.
- **Notas privadas**: cada tarea puede llevar una nota cifrada con AES-GCM (256 bits). La clave se deriva de una contraseña con PBKDF2-SHA256 y solo vive en memoria mientras las notas están desbloqueadas. Se bloquean solas tras 5 minutos sin actividad o 1 minuto con la app en segundo plano. Al cambiar la contraseña, todas las notas se vuelven a cifrar en una sola transacción.
- **Notas libres**: editables, con foto (cámara o galería, comprimida a JPEG) y audio grabado con el micrófono. No se cifran.
- **Offline e instalable**: service worker con caché del app shell y manifest para instalarla en el celular o el escritorio.

## Desarrollo

Requiere Node.js 20 o superior.

```sh
npm install
npm start          # http://localhost:8080 sin caché HTTP
npm run lint       # ESLint
npm run format     # Prettier (JS y JSON)
npm run check      # lint + formato, para antes de hacer commit
```

La cámara, el micrófono, el service worker y `crypto.subtle` solo funcionan en un contexto seguro: `localhost` o HTTPS.

Al cambiar cualquier archivo de `CORE_ASSETS`, sube `CACHE_NAME` en `sw.js` para que los usuarios reciban la versión nueva.

## Estructura

```
index.html       Vistas (inicio, tareas, calendario, horario, notas) y diálogos
css/style.css    Estilos, con modo claro/oscuro
js/app.js        Estado, rutas (#/vista), renderizado y eventos
js/db.js         IndexedDB: apertura, migraciones del esquema y CRUD
js/crypto.js     Primitivas: derivación de clave (PBKDF2) y AES-GCM
js/vault.js      Contraseña de las notas privadas: crear, desbloquear, cambiar
js/toast.js      Avisos no bloqueantes (reemplazan a alert())
js/device.js     Cámara, galería y grabación de audio
sw.js            Service worker y estrategias de caché
manifest.json    Manifest de la PWA
```

## Datos

Base IndexedDB `notux-db` (versión 4):

| Store    | Contenido                                                                       |
| -------- | ------------------------------------------------------------------------------- |
| `tasks`  | Tareas. Índices `byPriority` y `byTitle` (único). Nota privada cifrada opcional |
| `notes`  | Notas libres con `photo` y `audio` opcionales (Blob)                            |
| `config` | `privateNotes`: sal y texto de verificación de la contraseña                    |

Las migraciones de `openDatabase()` llevan los datos de versiones anteriores (nombres en español, localStorage) al esquema actual sin perderlos. Cualquier cambio de esquema debe subir `DB_VERSION` y agregar su paso de migración.

> Si se olvida la contraseña de las notas privadas, esas notas no se pueden recuperar.

## Estrategias de caché

| Recurso                   | Estrategia                                    |
| ------------------------- | --------------------------------------------- |
| Navegación                | Stale-while-revalidate; sin red, `index.html` |
| `icons/`                  | Cache first                                   |
| `api/`                    | Network first                                 |
| Resto (JS, CSS, manifest) | Stale-while-revalidate                        |
