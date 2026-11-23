# Notux API (backend)

Backend propio de Notux, escrito en TypeScript con **NestJS 11**, **Prisma** y **PostgreSQL**. Hace dos cosas:

1. **Inicio de sesión con Google** (OAuth 2.0, flujo de código en el servidor con PKCE).
2. **Respaldos en Google Drive**: guarda y recupera los respaldos JSON de la app en una carpeta visible llamada `Notux` dentro del Drive de cada usuario.

La PWA sigue funcionando completa sin cuenta y sin conexión; el backend solo agrega estas funciones opcionales.

- Sin cookies para la API: los tokens viajan en JSON y en `Authorization: Bearer <accessToken>`.
- Access token: JWT de 15 minutos. Refresh token: cadena aleatoria opaca de 30 días, guardada como hash, que **rota** en cada uso; si alguien reutiliza uno ya rotado se revoca toda la sesión (detección de reutilización por familia).
- El refresh token de Google se guarda **cifrado** (AES-256-GCM).
- Permiso de Drive `drive.file`: Notux solo ve los archivos que él mismo crea, nunca el resto del Drive.
- Seguridad: Helmet, CORS limitado a `FRONTEND_ORIGINS`, límite de peticiones (más estricto en `/auth/*`), validación global de entradas, variables de entorno validadas al arrancar.
- Documentación interactiva (Swagger) en `/docs`.

## Requisitos

- Node.js 20.12 o superior (probado con Node 26)
- Docker (para PostgreSQL en desarrollo)
- Un proyecto en Google Cloud (ver más abajo)

## Ejecutar en local

```bash
cd backend
docker compose up -d                 # PostgreSQL 17 en localhost:5432 (usuario/clave/base: notux)
cp .env.example .env                 # y completa los valores (ver tabla)
openssl rand -base64 32              # -> pégalo en TOKEN_ENCRYPTION_KEY
openssl rand -base64 48              # -> pégalo en JWT_SECRET
npm install
npm run prisma:migrate               # crea las tablas
npm run start:dev                    # http://localhost:3000  (docs en http://localhost:3000/docs)
```

Comprueba que todo está bien con `curl http://localhost:3000/health`.

Luego sirve el frontend (desde la raíz del repo, `npm start` lo abre en `http://localhost:8080`) con `API_URL = 'http://localhost:3000'` en `js/config.js`.

> Si el puerto 5432 ya está ocupado: `POSTGRES_PORT=5433 docker compose up -d` y cambia el puerto en `DATABASE_URL`.

### Scripts

| Script                   | Qué hace                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| `npm run start:dev`      | Servidor con recarga automática                                   |
| `npm run build`          | Compila a `dist/`                                                 |
| `npm start`              | Ejecuta la versión compilada (`node dist/main.js`)                |
| `npm test`               | Pruebas unitarias (no necesitan base de datos ni Google)          |
| `npm run test:e2e`       | Pruebas end-to-end contra el Postgres de Docker (Google simulado) |
| `npm run lint`           | ESLint                                                            |
| `npm run format`         | Prettier                                                          |
| `npm run prisma:migrate` | Crea/aplica migraciones en desarrollo                             |
| `npm run prisma:deploy`  | Aplica migraciones en producción                                  |

Las pruebas e2e usan una base separada, `notux_test`, en el mismo contenedor (se crea sola). Ninguna prueba necesita credenciales reales de Google.

## Configurar Google Cloud (paso a paso)

1. Entra a <https://console.cloud.google.com/> y crea un proyecto (por ejemplo «Notux»).
2. **Habilita la API de Google Drive**: _APIs y servicios → Biblioteca_ → busca «Google Drive API» → **Habilitar**.
3. **Pantalla de consentimiento** (_APIs y servicios → Pantalla de consentimiento de OAuth_, o _Google Auth Platform → Branding_ en la consola nueva):
   - Tipo de usuario: **Externo**.
   - Nombre de la app: «Notux», correo de asistencia y correo del desarrollador (los tuyos).
   - En **Acceso a datos / Permisos (scopes)** agrega: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` y `.../auth/drive.file`. `drive.file` es un permiso **no sensible**, así que no hace falta la verificación de Google.
   - **Usuarios de prueba** (_Audience_): mientras la app esté en modo «Testing», **solo** las cuentas que agregues aquí pueden iniciar sesión (máximo 100). Agrega tu cuenta de Google y las de quienes vayan a probar.
   - Nota: en modo «Testing» Google hace caducar los refresh tokens a los 7 días; Notux lo detecta y pide «Volver a conectar con Google». Para evitarlo, publica la app (_Publicar app → En producción_); con solo `drive.file` no requiere verificación.
4. **Crea las credenciales**: _APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth_:
   - Tipo de aplicación: **Aplicación web**.
   - **URIs de redireccionamiento autorizados**: `http://localhost:3000/auth/google/callback` (y en producción, `https://TU-API/auth/google/callback`). Debe coincidir **exactamente** con `GOOGLE_REDIRECT_URI`.
   - «Orígenes de JavaScript autorizados» no hace falta: el navegador nunca habla directamente con Google en este flujo.
5. Copia el **ID de cliente** y el **secreto** a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en `.env`. Nunca los subas al repositorio.

## Variables de entorno

Todas se validan al arrancar: si falta o es inválida alguna, el servidor se detiene con un mensaje que las enumera.

| Variable                   | Obligatoria | Ejemplo / valor por defecto                     | Descripción                                                                                                                                         |
| -------------------------- | ----------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | sí          | `postgresql://notux:notux@localhost:5432/notux` | Conexión a PostgreSQL                                                                                                                               |
| `PORT`                     | no          | `3000`                                          | Puerto HTTP                                                                                                                                         |
| `NODE_ENV`                 | no          | `development`                                   | `production` activa HSTS y cookies `Secure`                                                                                                         |
| `FRONTEND_ORIGINS`         | sí          | `http://localhost:8080`                         | Orígenes del frontend separados por comas (CORS y destinos permitidos tras el login). Puede incluir ruta: `https://usuario.github.io/notux/`        |
| `GOOGLE_CLIENT_ID`         | sí          | `…apps.googleusercontent.com`                   | ID de cliente OAuth                                                                                                                                 |
| `GOOGLE_CLIENT_SECRET`     | sí          | `GOCSPX-…`                                      | Secreto del cliente OAuth                                                                                                                           |
| `GOOGLE_REDIRECT_URI`      | sí          | `http://localhost:3000/auth/google/callback`    | Callback registrado en Google                                                                                                                       |
| `JWT_SECRET`               | sí          | (mín. 32 caracteres)                            | Firma de los access tokens. `openssl rand -base64 48`                                                                                               |
| `TOKEN_ENCRYPTION_KEY`     | sí          | (32 bytes en base64)                            | Clave AES-256-GCM para los tokens de Google y el `state` de OAuth. `openssl rand -base64 32`. Si cambia, los usuarios deben volver a iniciar sesión |
| `TRUST_PROXY`              | no          | `false`                                         | Pon `1` (o `true`) detrás de un proxy (Render, Railway, Fly) para que el límite de peticiones vea la IP real                                        |
| `SWAGGER_ENABLED`          | no          | `true`                                          | Sirve la documentación en `/docs`                                                                                                                   |
| `ACCESS_TOKEN_TTL_SECONDS` | no          | `900`                                           | Duración del access token                                                                                                                           |
| `REFRESH_TOKEN_TTL_DAYS`   | no          | `30`                                            | Duración del refresh token                                                                                                                          |

## Endpoints

Errores con la forma de Nest: `{ statusCode, message, error, code? }`. El frontend se guía por `code` cuando existe.

| Método y ruta                 | Auth   | Descripción                                                                                                                                       |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                 | —      | 200 `{ status: "ok", info: { database: { status: "up" } } }`; 503 si la base de datos no responde                                                 |
| `GET /auth/google?redirect=…` | —      | 302 a Google. `redirect` debe pertenecer a `FRONTEND_ORIGINS` (si no, 400 `INVALID_REDIRECT`)                                                     |
| `GET /auth/google/callback`   | —      | Lo llama Google. 302 a `<redirect>?login_code=…` o `<redirect>?auth_error=access_denied\|server_error\|invalid_state`                             |
| `POST /auth/exchange`         | —      | `{ code }` → `{ accessToken, refreshToken, expiresIn, user }`. Código de un solo uso, válido 60 s. 401 `INVALID_LOGIN_CODE`                       |
| `POST /auth/refresh`          | —      | `{ refreshToken }` → `{ accessToken, refreshToken, expiresIn }` (rota el token). 401 `INVALID_REFRESH_TOKEN`                                      |
| `POST /auth/logout`           | —      | `{ refreshToken }` → 204 (idempotente)                                                                                                            |
| `GET /users/me`               | Bearer | `{ id, email, name, picture, driveConnected }`                                                                                                    |
| `GET /drive/backups`          | Bearer | `[{ id, name, createdTime, size }]`, del más nuevo al más viejo (máx. 20)                                                                         |
| `POST /drive/backups`         | Bearer | Cuerpo = JSON de `createBackup()` (máx. 25 MB; `app: "notux"`, `format: 1`, si no 400 `INVALID_BACKUP`) → 201. Conserva solo los 10 más recientes |
| `GET /drive/backups/:id`      | Bearer | El JSON del respaldo, exactamente como se subió. 404 si no existe o no es un respaldo de Notux                                                    |
| `DELETE /drive/backups/:id`   | Bearer | 204                                                                                                                                               |

Errores de Drive: 403 `DRIVE_NOT_AUTHORIZED` si no hay permiso o Google lo revocó (`invalid_grant`) → el usuario debe volver a iniciar sesión con Google; 502 `DRIVE_UNAVAILABLE` si Google falla.

Límite de peticiones: 120 por minuto por IP en general y 20 por minuto en `/auth/*` (429 al superarlo).

### Cómo es el inicio de sesión

1. El frontend navega a `GET /auth/google?redirect=<url del frontend>`.
2. El backend genera PKCE y un `state` cifrado (con la URL de vuelta y una marca de tiempo; caduca en 10 min), guarda un _nonce_ en una cookie `httpOnly` limitada a `/auth/google` (protege contra CSRF de login; no la usa el frontend) y redirige a Google.
3. Google vuelve a `/auth/google/callback`; el backend canjea el código, crea o actualiza el usuario, guarda cifrado el refresh token de Google y redirige al frontend con un `login_code` de un solo uso (60 s).
4. El frontend lo canjea en `POST /auth/exchange` por sus tokens.

## Despliegue

**GitHub Pages solo sirve archivos estáticos**: puede alojar el frontend, pero no este backend. Opciones sencillas para la API:

- **Render** (Web Service + Render Postgres), **Railway** (servicio Node + plugin Postgres) o **Fly.io** (app + Fly Postgres / Neon / Supabase).
- Comandos típicos:
  - Root directory: `backend`
  - Build: `npm ci && npm run build && npx prisma migrate deploy`
  - Start: `npm start`
- Variables en producción: `NODE_ENV=production`, `TRUST_PROXY=1`, `DATABASE_URL` (la que da el proveedor; muchas requieren `?sslmode=require`), `FRONTEND_ORIGINS=https://usuario.github.io/notux/`, `GOOGLE_REDIRECT_URI=https://TU-API/auth/google/callback` (y agrégala en Google Cloud), y secretos **nuevos** para `JWT_SECRET` y `TOKEN_ENCRYPTION_KEY`.
- En el frontend, pon `API_URL` con la URL pública de la API.
- Health check del proveedor: `GET /health`.
- Considera `SWAGGER_ENABLED=false` en producción si no quieres exponer la documentación.

## Estructura

```
backend/
├── prisma/                 # schema.prisma + migraciones
├── src/
│   ├── main.ts             # arranque (valida el entorno y levanta el servidor)
│   ├── app.setup.ts        # Helmet, CORS, límites de cuerpo, ValidationPipe, Swagger
│   ├── config/             # validación de variables de entorno
│   ├── common/             # cifrado AES-GCM, hashes, errores con `code`
│   ├── prisma/             # PrismaService
│   ├── health/             # /health (terminus + ping a Postgres)
│   ├── google/             # cliente OAuth de Google (google-auth-library)
│   ├── auth/               # login con Google, login codes, JWT, refresh tokens
│   ├── users/              # /users/me
│   └── drive/              # cliente REST de Drive v3 y respaldos
└── test/                   # pruebas e2e (Google y Drive simulados)
```
