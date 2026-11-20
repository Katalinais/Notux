# Notux

PWA para organizar tareas, notas, un calendario y el horario semanal de clases. Funciona sin conexión y guarda todo en el navegador: no hay servidor ni cuentas.

## Funcionalidades

- **Tareas**: título, fecha límite y prioridad; editar, eliminar con opción de deshacer, búsqueda, filtro por prioridad y marcar en bloque como hechas.
- **Calendario**: vista de mes con las tareas en su fecha límite (títulos en pantallas anchas, puntos de color en el celular), lista del día seleccionado y alta rápida de tareas para ese día. Se navega con las flechas, Inicio/Fin y RePág/AvPág.
- **Horario**: clases o actividades semanales con día, hora, lugar y color. Una clase se puede crear en varios días a la vez; avisa si se cruza con otra. Cuadrícula semanal en pantallas anchas y agenda por día en el celular. Inicio muestra las clases de hoy con lo que está pasando ahora y lo siguiente.
- **Notas privadas**: cada tarea puede llevar una nota cifrada con AES-GCM (256 bits). La clave se deriva de una contraseña con PBKDF2-SHA256 y solo vive en memoria mientras las notas están desbloqueadas. Se bloquean solas tras 5 minutos sin actividad o 1 minuto con la app en segundo plano. Al cambiar la contraseña, todas las notas se vuelven a cifrar en una sola transacción.
- **Notas libres**: editables, con foto (cámara o galería, comprimida a JPEG) y audio grabado con el micrófono. No se cifran.
- **Respaldo**: en Ajustes se descarga un JSON con todos los datos (incluidas fotos, audios y notas privadas cifradas) y se puede restaurar aquí o en otro dispositivo. Restaurar reemplaza todo en una sola transacción.
- **Recordatorio diario**: notificación por la mañana con lo que vence hoy, lo vencido y las clases del día (ver limitaciones abajo).
- **Offline e instalable**: service worker con caché del app shell y manifest para instalarla en el celular o el escritorio. Cuando hay una versión nueva, la app avisa y se actualiza al pulsar «Actualizar».

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
js/calendar.js   Vista de calendario
js/backup.js     Respaldo: exportar/importar JSON (binarios en base64 con su tipo)
js/reminders.js  Ajustes del recordatorio diario (Periodic Background Sync)
js/schedule.js   Horario semanal: lógica (cruces, columnas, ahora/siguiente) y vista
js/dates.js      Fechas como 'YYYY-MM-DD' locales, cuadrícula del mes, formatos es-CO
js/dom.js        Ayudantes para crear elementos e íconos
js/device.js     Cámara, galería y grabación de audio
sw.js            Service worker y estrategias de caché
manifest.json    Manifest de la PWA
```

## Datos

Base IndexedDB `notux-db` (versión 5):

| Store      | Contenido                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tasks`    | Tareas. Índices `byPriority` y `byTitle` (único). Nota privada cifrada opcional                                             |
| `notes`    | Notas libres con `photo` y `audio` opcionales (Blob)                                                                        |
| `schedule` | Bloques del horario: `day` (0 = domingo … 6 = sábado), `start`/`end` (`HH:MM`), `subject`, `place`, `color`. Índice `byDay` |
| `config`   | `privateNotes`: sal y texto de verificación de la contraseña                                                                |

Las migraciones de `openDatabase()` llevan los datos de versiones anteriores (nombres en español, localStorage) al esquema actual sin perderlos. Cualquier cambio de esquema debe subir `DB_VERSION` y agregar su paso de migración.

> Si se olvida la contraseña de las notas privadas, esas notas no se pueden recuperar.

## Estrategias de caché

| Recurso                   | Estrategia                                    |
| ------------------------- | --------------------------------------------- |
| Navegación                | Stale-while-revalidate; sin red, `index.html` |
| `icons/`                  | Cache first                                   |
| `api/`                    | Network first                                 |
| Resto (JS, CSS, manifest) | Stale-while-revalidate                        |

## Actualizaciones

El service worker nuevo se instala en segundo plano y **espera**: la app muestra «Hay una versión nueva» y solo al pulsar «Actualizar» se activa y la página se recarga. Así nunca se mezcla HTML viejo con JS nuevo en una pestaña abierta.

## Recordatorio diario: limitaciones

Sin un servidor de notificaciones push no hay forma fiable de programar una hora exacta. El recordatorio usa **Periodic Background Sync**, que:

- solo existe en navegadores Chromium (Chrome, Edge, Samsung Internet; no en Safari ni Firefox);
- solo funciona con la app **instalada**;
- se ejecuta como mucho cada ~12 h, cuando el navegador lo decide según cuánto se use la app.

El service worker lee IndexedDB, arma el resumen y no avisa antes de las 6:00 ni más de una vez al día. Ajustes muestra qué puede hacer el dispositivo y tiene un botón para enviar una notificación de prueba.

## Formato del respaldo

```json
{
  "app": "notux",
  "format": 1,
  "dbVersion": 5,
  "exportedAt": "…",
  "tasks": [],
  "notes": [],
  "schedule": [],
  "config": []
}
```

Los valores binarios se guardan como `{ "$type": "blob" | "arraybuffer" | "uint8array", "data": "<base64>" }` (los blobs además con `mime`), y se reconstruyen con el mismo tipo al restaurar.
