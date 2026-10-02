const DB_NAME = 'notux-db';
const DB_VERSION = 1;

export function abrirBaseDeDatos() {
  return new Promise((resolve, reject) => {
    const peticion = indexedDB.open(DB_NAME, DB_VERSION);

    peticion.onupgradeneeded = event => {
      const db = event.target.result;
      const version = event.oldVersion;

      if (version < 1) {
        const tareas = db.createObjectStore('tareas', { keyPath: 'id', autoIncrement: true });
        tareas.createIndex('porPrioridad', 'prioridad', { unique: false });
        db.createObjectStore('config', { keyPath: 'id' });
      }
    };

    peticion.onsuccess = event => resolve(event.target.result);
    peticion.onerror = event => reject(event.target.error);
  });
}

export function agregarTarea(db, tarea) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tareas', 'readwrite');
    const peticion = tx.objectStore('tareas').add(tarea);
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => reject(peticion.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function actualizarTarea(db, tarea) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tareas', 'readwrite');
    const peticion = tx.objectStore('tareas').put(tarea);
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => reject(peticion.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function obtenerTarea(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tareas', 'readonly');
    const peticion = tx.objectStore('tareas').get(id);
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => reject(peticion.error);
  });
}

export function eliminarTarea(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tareas', 'readwrite');
    const peticion = tx.objectStore('tareas').delete(id);
    peticion.onsuccess = () => resolve();
    peticion.onerror = () => reject(peticion.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function obtenerTodasLasTareas(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tareas', 'readonly');
    const peticion = tx.objectStore('tareas').getAll();
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => reject(peticion.error);
  });
}

export function contarTareas(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tareas', 'readonly');
    const peticion = tx.objectStore('tareas').count();
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => reject(peticion.error);
  });
}

// Recorre solo las tareas de una prioridad con un cursor sobre el índice,
// en vez de traer todo el store y filtrar en memoria.
export function tareasPorPrioridad(db, prioridad) {
  return new Promise((resolve, reject) => {
    const resultado = [];
    const store = db.transaction('tareas', 'readonly').objectStore('tareas');
    const indice = store.index('porPrioridad');
    const cursor = indice.openCursor(IDBKeyRange.only(prioridad));

    cursor.onsuccess = event => {
      const c = event.target.result;
      if (c) {
        resultado.push(c.value);
        c.continue();
      } else {
        resolve(resultado);
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export function guardarConfig(db, registro) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readwrite');
    const peticion = tx.objectStore('config').put(registro);
    peticion.onsuccess = () => resolve();
    peticion.onerror = () => reject(peticion.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function obtenerConfig(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readonly');
    const peticion = tx.objectStore('config').get(id);
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => reject(peticion.error);
  });
}
