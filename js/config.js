// Base URL of the Notux API (the NestJS backend in backend/), used for the
// optional account: sign-in with Google and backups in Google Drive.
//
// Leave it empty to run Notux without an account: the app works exactly the
// same, Ajustes → Cuenta just says accounts aren't set up, and nothing is ever
// sent to a server.
//
// Examples:
//   'http://localhost:3000'          the backend running locally (backend/README.md)
//   'http://localhost:3100'          the in-memory mock: npm run mock-api (dev/mock-api.mjs)
//   'https://api.example.com'        a deployed backend (a trailing slash is fine)
//
// The page's origin must be listed in the backend's FRONTEND_ORIGINS (CORS and
// the allowed sign-in redirects). Nothing here is secret: it ships to every browser.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// Local development uses the backend on port 3000; anywhere else (e.g. GitHub
// Pages) stays without an account until a deployed API URL is set here.
export const API_URL = LOCAL ? 'http://localhost:3000' : '';
