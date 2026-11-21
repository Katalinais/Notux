# Notux

PWA para organizar materias, tareas, notas, un calendario y el horario semanal de clases. Funciona sin conexión y guarda todo en el navegador: no hay servidor ni cuentas.

## Funcionalidades

- **Inicio**: saludo y alta rápida de tareas; contadores (vencidas, para hoy, próximos 7 días, completadas) que abren Tareas ya filtrada; «Qué sigue» con las pendientes agrupadas (vencidas, hoy, mañana, esta semana, más adelante, sin fecha); las clases de hoy; las materias con su próxima clase y las notas recientes.
- **Tareas**: título, fecha límite, prioridad, materia y nota privada. El formulario va al lado de la lista en pantallas anchas y se despliega con «Nueva tarea» en el celular. Editar, eliminar con opción de deshacer, búsqueda, filtros por estado, prioridad y materia, y marcar en bloque como hechas.
- **Calendario**: vista de mes con las tareas en su fecha límite (títulos en pantallas anchas, puntos de color en el celular), lista del día seleccionado y alta rápida de tareas para ese día. Se navega con las flechas, Inicio/Fin y RePág/AvPág.
- **Materias**: cada materia (o actividad) tiene nombre, color y los horarios que necesite, cada uno con su día, hora y lugar (p. ej. lunes 7–9 en C-204 y miércoles 14–16 en el laboratorio). Las tareas y las notas se pueden asignar a una materia; cada materia tiene su página con sus horarios, sus tareas (con alta rápida) y sus notas. Eliminar una materia quita sus horarios y deja sus tareas y notas sin materia (con «Deshacer»).
- **Horario**: cuadrícula semanal en pantallas anchas y agenda por día en el celular; avisa si un horario se cruza con otro. Inicio muestra las clases de hoy con lo que está pasando ahora y lo siguiente.
- **Notas privadas**: cada tarea puede llevar una nota cifrada con AES-GCM (256 bits). La clave se deriva de una contraseña con PBKDF2-SHA256 y solo vive en memoria mientras las notas están desbloqueadas. Se bloquean solas tras 5 minutos sin actividad o 1 minuto con la app en segundo plano. Al cambiar la contraseña, todas las notas se vuelven a cifrar en una sola transacción.
- **Notas libres**: un lienzo donde cada nota se queda donde la sueltes (arrastrándola, o con su asa y las flechas del teclado); «Ordenar» las vuelve a acomodar en columnas. Filtro por materia; el formulario se despliega con «Nueva nota». Editables, con foto (cámara o galería, comprimida a JPEG) y audio grabado con el micrófono. No se cifran.
- **Modo oscuro**: claro, oscuro o igual que el sistema (en Ajustes → Apariencia, o con el botón del menú lateral). La elección se guarda en el navegador y se aplica antes de pintar la página, sin destellos.
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
index.html       Vistas (inicio, tareas, calendario, horario, materia, notas) y diálogos
css/style.css    Estilos, con modo claro/oscuro
js/app.js        Estado, rutas (#/vista, #/materia/ID), renderizado y eventos
js/db.js         IndexedDB: apertura, migraciones del esquema y CRUD
js/crypto.js     Primitivas: derivación de clave (PBKDF2) y AES-GCM
js/vault.js      Contraseña de las notas privadas: crear, desbloquear, cambiar
js/toast.js      Avisos no bloqueantes (reemplazan a alert())
js/calendar.js   Vista de calendario
js/note-board.js Lienzo de notas: posiciones, arrastre y teclado
js/backup.js     Respaldo: exportar/importar JSON (binarios en base64 con su tipo)
js/reminders.js  Ajustes del recordatorio diario (Periodic Background Sync)
js/schedule.js   Materias y horario: lógica (cruces, columnas, ahora/siguiente), diálogo y vistas
js/subjects.js   Reglas de las materias: colores, nombres, conversión de clases antiguas
js/dates.js      Fechas como 'YYYY-MM-DD' locales, cuadrícula del mes, formatos es-CO
js/dom.js        Ayudantes para crear elementos e íconos
js/device.js     Cámara, galería y grabación de audio
sw.js            Service worker y estrategias de caché
manifest.json    Manifest de la PWA
```

## Datos

Base IndexedDB `notux-db` (versión 6):

| Store      | Contenido                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tasks`    | Tareas. Índices `byPriority` y `byTitle` (único). Nota privada cifrada opcional. `subjectId` opcional                         |
| `notes`    | Notas libres con `photo` y `audio` opcionales (Blob). `subjectId` y `board` (`{ x, y, z }`, su lugar en el lienzo) opcionales |
| `subjects` | Materias: `name`, `color`                                                                                                     |
| `schedule` | Horarios de cada materia: `subjectId`, `day` (0 = domingo … 6 = sábado), `start`/`end` (`HH:MM`), `place`. Índice `byDay`     |
| `config`   | `privateNotes`: sal y texto de verificación de la contraseña                                                                  |

La migración a la versión 6 convierte cada clase antigua (que tenía su propio nombre y color) en una materia; las clases con el mismo nombre quedan en una sola. Las migraciones de `openDatabase()` llevan los datos de versiones anteriores (nombres en español, localStorage) al esquema actual sin perderlos. Cualquier cambio de esquema debe subir `DB_VERSION` y agregar su paso de migración.

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
  "dbVersion": 6,
  "exportedAt": "…",
  "tasks": [],
  "notes": [],
  "subjects": [],
  "schedule": [],
  "config": []
}
```

Los respaldos de la versión 5 (sin `subjects`) se siguen pudiendo restaurar: sus clases se convierten en materias igual que en la migración de la base. Los valores binarios se guardan como `{ "$type": "blob" | "arraybuffer" | "uint8array", "data": "<base64>" }` (los blobs además con `mime`), y se reconstruyen con el mismo tipo al restaurar.
