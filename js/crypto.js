const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PBKDF2_ITERATIONS = 100000; // mínimo recomendado por OWASP para PBKDF2-SHA256 (revisar vigencia)

export async function calcularHash(texto) {
  const datos = textEncoder.encode(texto);
  const buffer = await crypto.subtle.digest('SHA-256', datos);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generarSal() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// Deriva una clave AES-GCM reproducible a partir de una contraseña y una sal.
// No es exportable: no se puede leer ni guardar, solo volver a derivar.
export async function derivarClaveDesdeContrasena(contrasena, sal) {
  const materialBase = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(contrasena),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: sal, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    materialBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function cifrarTexto(clave, texto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = textEncoder.encode(texto);
  const cifrado = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, clave, datos);
  return { cifrado, iv }; // el IV no es secreto, se guarda junto al cifrado
}

// Si la clave o el IV no corresponden, o el cifrado fue alterado, decrypt()
// rechaza la promesa en vez de devolver datos corruptos.
export async function descifrarTexto(clave, { cifrado, iv }) {
  const datos = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, clave, cifrado);
  return textDecoder.decode(datos);
}
