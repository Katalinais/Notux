// Password management for private notes. Pure functions over the database:
// the caller decides where the derived key lives (here, a variable in app.js).
import { getConfig, saveConfig, getAllTasks, replaceNotesEncryption } from './db.js';
import { generateSalt, deriveKeyFromPassword, encryptText, decryptText } from './crypto.js';

const CONFIG_ID = 'privateNotes';
const CHECK_TEXT = 'notux-verificacion'; // internal sentinel only, never shown — keep stable across renames

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'WrongPasswordError';
  }
}

export async function isPasswordConfigured(db) {
  return !!(await getConfig(db, CONFIG_ID));
}

async function buildConfig(password) {
  const salt = generateSalt();
  const key = await deriveKeyFromPassword(password, salt);
  const verification = await encryptText(key, CHECK_TEXT);
  return { key, config: { id: CONFIG_ID, salt, verification } };
}

// First-time setup. Returns the key so the notes start unlocked.
export async function createPassword(db, password) {
  const { key, config } = await buildConfig(password);
  await saveConfig(db, config);
  return key;
}

// Returns the key if the password is right; throws WrongPasswordError otherwise.
export async function unlockWithPassword(db, password) {
  const config = await getConfig(db, CONFIG_ID);
  if (!config) throw new Error('No password configured');
  const key = await deriveKeyFromPassword(password, config.salt);
  try {
    // With a wrong key AES-GCM rejects instead of returning garbage.
    if ((await decryptText(key, config.verification)) === CHECK_TEXT) return key;
  } catch {
    // fall through
  }
  throw new WrongPasswordError();
}

export async function encryptNote(key, text) {
  const { ciphertext, iv } = await encryptText(key, text);
  return { encryptedNote: ciphertext, noteIv: iv };
}

export function decryptNote(key, task) {
  return decryptText(key, { ciphertext: task.encryptedNote, iv: task.noteIv });
}

// Re-encrypts every private note under a key derived from the new password.
// Everything is decrypted first, so a note that can't be read aborts the change
// before anything is written; then the new config and all tasks are saved in a
// single transaction, so a crash can't leave notes split across two keys.
export async function changePassword(db, currentPassword, newPassword) {
  const oldKey = await unlockWithPassword(db, currentPassword);
  const withNotes = (await getAllTasks(db)).filter((t) => t.encryptedNote);
  const plain = await Promise.all(withNotes.map((t) => decryptNote(oldKey, t)));

  const { key, config } = await buildConfig(newPassword);
  const updated = await Promise.all(withNotes.map(async (t, i) => ({ ...t, ...(await encryptNote(key, plain[i])) })));
  await replaceNotesEncryption(db, config, updated);
  return key;
}
