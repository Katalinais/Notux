const DB_NAME = 'notux-db';
const DB_VERSION = 5;

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

export const createBlock = (db, block) => run(db, 'schedule', 'readwrite', (s) => s.add(block));
export const updateBlock = (db, block) => run(db, 'schedule', 'readwrite', (s) => s.put(block));
export const deleteBlock = (db, id) => run(db, 'schedule', 'readwrite', (s) => s.delete(id));
export const getAllBlocks = (db) => run(db, 'schedule', 'readonly', (s) => s.getAll());

// Adds several blocks in one transaction (a class on Mon + Wed is saved as two
// blocks together, or not at all). Resolves with the new ids, in order.
export function createBlocks(db, blocks) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('schedule', 'readwrite');
    const store = tx.objectStore('schedule');
    const ids = [];
    blocks.forEach((b, i) => {
      store.add(b).onsuccess = (e) => (ids[i] = e.target.result);
    });
    tx.oncomplete = () => resolve(ids);
    tx.onabort = () => reject(tx.error);
  });
}
