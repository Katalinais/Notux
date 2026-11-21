import { subjectsFromLegacyBlocks } from './subjects.js';

const DB_NAME = 'notux-db';
const DB_VERSION = 6;

// onBlocked: another tab still has an older version open, so the upgrade waits
// until it closes. onVersionChange: a newer version (another tab, after an
// update) wants to upgrade; this connection closes itself so it doesn't block it.
export function openDatabase({ onBlocked, onVersionChange } = {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        const tasks = db.createObjectStore('tasks', { keyPath: 'id', autoIncrement: true });
        tasks.createIndex('byPriority', 'priority', { unique: false });
        tasks.createIndex('byTitle', 'title', { unique: true });
        db.createObjectStore('config', { keyPath: 'id' });
      }

      // v1 -> v2: the original schema used Spanish store/field names
      // (tareas, prioridad, notaCifrada, notaIv, sal, verificacion, notasPrivadas).
      // Rename everything to English in place, keeping whatever was already saved.
      if (oldVersion >= 1 && oldVersion < 2 && db.objectStoreNames.contains('tareas')) {
        const legacyStore = tx.objectStore('tareas');
        const newStore = db.createObjectStore('tasks', { keyPath: 'id', autoIncrement: true });
        newStore.createIndex('byPriority', 'priority', { unique: false });
        newStore.createIndex('byTitle', 'title', { unique: true });

        const priorityMap = { alta: 'high', media: 'medium', baja: 'low' };
        const seenTitles = new Set(); // byTitle is unique: dedupe before copying, don't just fail

        legacyStore.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) {
            db.deleteObjectStore('tareas'); // only once every record was copied
            return;
          }
          const old = cursor.value;
          let title = old.title;
          for (let n = 2; seenTitles.has(title); n++) title = `${old.title} (${n})`;
          seenTitles.add(title);

          newStore.add({
            title,
            due: old.due,
            done: old.done,
            priority: priorityMap[old.prioridad] ?? 'medium',
            createdAt: old.createdAt,
            completedAt: old.completedAt,
            encryptedNote: old.notaCifrada,
            noteIv: old.notaIv,
          });
          cursor.continue();
        };
      }

      if (oldVersion >= 1 && oldVersion < 2 && db.objectStoreNames.contains('config')) {
        // Snapshot the records first with getAll(): renaming a primary key means
        // delete+add, and a live cursor would re-visit a record we just re-added.
        const configStore = tx.objectStore('config');
        configStore.getAll().onsuccess = (e) => {
          for (const old of e.target.result) {
            const migrated = {
              id: old.id === 'notasPrivadas' ? 'privateNotes' : old.id,
              salt: old.salt ?? old.sal,
              verification: old.verification ?? { ciphertext: old.verificacion.cifrado, iv: old.verificacion.iv },
            };
            if (migrated.id !== old.id) {
              configStore.delete(old.id);
              configStore.add(migrated);
            } else {
              configStore.put(migrated);
            }
          }
        };
      }

      // v2 -> v3: a free-form notes store (title, text, optional photo), separate
      // from the encrypted notaPrivada field that lives on individual tasks.
      if (oldVersion < 3) {
        db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
      }

      // v3 -> v4: a unique index on title. createIndex() builds the index from
      // whatever is in the store at the moment it runs, so any duplicate titles
      // already saved have to be renamed first — otherwise this step fails outright.
      if (oldVersion >= 1 && oldVersion < 4 && db.objectStoreNames.contains('tasks')) {
        const store = tx.objectStore('tasks');
        if (!store.indexNames.contains('byTitle')) {
          const seenTitles = new Set();
          store.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) {
              store.createIndex('byTitle', 'title', { unique: true });
              return;
            }
            const task = cursor.value;
            let title = task.title;
            for (let n = 2; seenTitles.has(title); n++) title = `${task.title} (${n})`;
            seenTitles.add(title);
            if (title !== task.title) cursor.update({ ...task, title });
            cursor.continue();
          };
        }
      }

      // v4 -> v5: weekly schedule blocks (day 0–6 as in Date#getDay, start/end 'HH:MM').
      if (oldVersion < 5) {
        const schedule = db.createObjectStore('schedule', { keyPath: 'id', autoIncrement: true });
        schedule.createIndex('byDay', 'day', { unique: false });
      }

      // v5 -> v6: subjects (materias). Blocks used to carry their own name and
      // color; now they point to a subject, and tasks/notes can point to one too.
      // Blocks with the same name become a single subject.
      if (oldVersion < 6) {
        const subjects = db.createObjectStore('subjects', { keyPath: 'id', autoIncrement: true });
        if (oldVersion >= 5) {
          const schedule = tx.objectStore('schedule');
          schedule.getAll().onsuccess = (e) => {
            const migrated = subjectsFromLegacyBlocks(e.target.result);
            for (const s of migrated.subjects) subjects.add(s);
            for (const b of migrated.blocks) schedule.put(b);
          };
        }
      }
    };

    request.onblocked = () => onBlocked?.();
    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onversionchange = () => {
        db.close();
        onVersionChange?.();
      };
      resolve(db);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

export function createTask(db, task) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readwrite');
    const request = tx.objectStore('tasks').add(task);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function updateTask(db, task) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readwrite');
    const request = tx.objectStore('tasks').put(task);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getTask(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readonly');
    const request = tx.objectStore('tasks').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function deleteTask(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readwrite');
    const request = tx.objectStore('tasks').delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getAllTasks(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readonly');
    const request = tx.objectStore('tasks').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function countTasks(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readonly');
    const request = tx.objectStore('tasks').count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Walks only the tasks of one priority with a cursor over the index,
// instead of fetching the whole store and filtering in memory.
export function tasksByPriority(db, priority) {
  return new Promise((resolve, reject) => {
    const result = [];
    const store = db.transaction('tasks', 'readonly').objectStore('tasks');
    const index = store.index('byPriority');
    const cursorRequest = index.openCursor(IDBKeyRange.only(priority));

    cursorRequest.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        result.push(cursor.value);
        cursor.continue();
      } else {
        resolve(result);
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

// Write counterpart to tasksByPriority(): walks the same index in a readwrite
// cursor and marks each matching task done with cursor.update(), in place.
export function markTasksDoneByPriority(db, priority) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readwrite');
    const index = tx.objectStore('tasks').index('byPriority');
    const cursorRequest = index.openCursor(IDBKeyRange.only(priority));
    let updated = 0;

    cursorRequest.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      const task = cursor.value;
      if (!task.done) {
        cursor.update({ ...task, done: true, completedAt: new Date().toISOString() });
        updated++;
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
  });
}

export function saveConfig(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readwrite');
    const request = tx.objectStore('config').put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getConfig(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readonly');
    const request = tx.objectStore('config').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createNote(db, note) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    const request = tx.objectStore('notes').add(note);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function deleteNote(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    const request = tx.objectStore('notes').delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getAllNotes(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readonly');
    const request = tx.objectStore('notes').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function updateNote(db, note) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    const request = tx.objectStore('notes').put(note);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Writes several notes in one transaction (e.g. clearing every position on the board).
export function putNotes(db, notes) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    for (const note of notes) store.put(note);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

// Saves the password config and the re-encrypted tasks in one transaction:
// either every note moves to the new key together with the new salt, or nothing
// changes. Resolves only once the transaction has committed.
export function replaceNotesEncryption(db, config, tasks) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['config', 'tasks'], 'readwrite');
    tx.objectStore('config').put(config);
    const taskStore = tx.objectStore('tasks');
    for (const task of tasks) taskStore.put(task);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

/* ---------- Schedule ---------- */
function run(db, storeName, mode, makeRequest) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = makeRequest(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getAllBlocks = (db) => run(db, 'schedule', 'readonly', (s) => s.getAll());

/* ---------- Subjects ---------- */
export const getAllSubjects = (db) => run(db, 'subjects', 'readonly', (s) => s.getAll());

const withoutEmptyId = ({ id, ...rest }) => (id == null ? rest : { id, ...rest });

/**
 * Saves a subject together with its schedule in one transaction: the subject
 * (new or existing), the blocks to add or update, and the blocks to remove.
 * Resolves with { id, blockIds } once everything has committed.
 */
export function saveSubject(db, subject, blocks = [], removeBlockIds = []) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['subjects', 'schedule'], 'readwrite');
    const schedule = tx.objectStore('schedule');
    const result = { id: null, blockIds: [] };
    const request = tx.objectStore('subjects').put(withoutEmptyId(subject));
    request.onsuccess = () => {
      result.id = request.result;
      for (const id of removeBlockIds) schedule.delete(id);
      blocks.forEach((b, i) => {
        schedule.put(withoutEmptyId({ ...b, subjectId: result.id })).onsuccess = (e) =>
          (result.blockIds[i] = e.target.result);
      });
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error);
  });
}

// Unlinks every record of `storeName` that points to the subject; collects their ids.
function unlinkSubject(store, subjectId, ids) {
  store.openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    if (cursor.value.subjectId === subjectId) {
      ids.push(cursor.value.id);
      cursor.update({ ...cursor.value, subjectId: null });
    }
    cursor.continue();
  };
}

/**
 * Deletes a subject and its schedule blocks; its tasks and notes stay, just
 * without a subject. Resolves with a snapshot that restoreSubject() can undo.
 */
export function deleteSubject(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['subjects', 'schedule', 'tasks', 'notes'], 'readwrite');
    const snapshot = { subject: null, blocks: [], taskIds: [], noteIds: [] };
    const subjects = tx.objectStore('subjects');
    subjects.get(id).onsuccess = (e) => (snapshot.subject = e.target.result ?? null);
    subjects.delete(id);
    const schedule = tx.objectStore('schedule');
    schedule.getAll().onsuccess = (e) => {
      for (const b of e.target.result) {
        if (b.subjectId !== id) continue;
        snapshot.blocks.push(b);
        schedule.delete(b.id);
      }
    };
    unlinkSubject(tx.objectStore('tasks'), id, snapshot.taskIds);
    unlinkSubject(tx.objectStore('notes'), id, snapshot.noteIds);
    tx.oncomplete = () => resolve(snapshot);
    tx.onabort = () => reject(tx.error);
  });
}

// Undoes deleteSubject(): same ids, and relinks the tasks and notes that still
// exist and haven't been given another subject in the meantime.
export function restoreSubject(db, snapshot) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['subjects', 'schedule', 'tasks', 'notes'], 'readwrite');
    tx.objectStore('subjects').add(snapshot.subject);
    const schedule = tx.objectStore('schedule');
    for (const b of snapshot.blocks) schedule.add(b);
    const relink = (storeName, ids) => {
      const store = tx.objectStore(storeName);
      for (const recordId of ids) {
        store.get(recordId).onsuccess = (e) => {
          const record = e.target.result;
          if (record && record.subjectId == null) store.put({ ...record, subjectId: snapshot.subject.id });
        };
      }
    };
    relink('tasks', snapshot.taskIds);
    relink('notes', snapshot.noteIds);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

/* ---------- Backup ---------- */
export const DATA_STORES = ['tasks', 'notes', 'subjects', 'schedule', 'config'];
export { DB_VERSION };

// Reads every store in one readonly transaction, so the snapshot is consistent.
export function exportAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DATA_STORES, 'readonly');
    const out = {};
    for (const name of DATA_STORES) {
      tx.objectStore(name).getAll().onsuccess = (e) => (out[name] = e.target.result);
    }
    tx.oncomplete = () => resolve(out);
    tx.onabort = () => reject(tx.error);
  });
}

// Replaces the contents of every store in one transaction: if any record is
// rejected (e.g. a duplicate task title), nothing is cleared or written.
export function replaceAll(db, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DATA_STORES, 'readwrite');
    for (const name of DATA_STORES) {
      const store = tx.objectStore(name);
      store.clear();
      for (const record of data[name] ?? []) store.add(record);
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
