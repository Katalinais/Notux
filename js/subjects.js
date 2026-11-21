// Subjects (materias): the thread that ties the schedule, tasks and notes
// together. A subject has a name and a color; schedule blocks always belong to
// one (block.subjectId), tasks and notes may (task.subjectId / note.subjectId,
// missing or null = "sin materia").
//
// Pure helpers only — no DOM, no IndexedDB — so the DB migration, the backup
// import and the views all share exactly the same rules.

export const COLORS = [
  ['indigo', 'Índigo'],
  ['sky', 'Celeste'],
  ['emerald', 'Verde'],
  ['amber', 'Ámbar'],
  ['orange', 'Naranja'],
  ['rose', 'Rosa'],
  ['violet', 'Violeta'],
  ['slate', 'Gris'],
];
const COLOR_KEYS = new Set(COLORS.map(([key]) => key));

export const DEFAULT_COLOR = 'indigo';
export const validColor = (c) => (COLOR_KEYS.has(c) ? c : DEFAULT_COLOR);

// Next color in the palette, so new subjects don't all start indigo.
export const suggestColor = (count) => COLORS[count % COLORS.length][0];

// Comparison key for names: "  Cálculo " and "cálculo" are the same subject.
export const nameKey = (name) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
export const cleanName = (name) => name.trim().replace(/\s+/g, ' ');

export function findByName(subjects, name, exceptId = null) {
  const key = nameKey(name);
  return subjects.find((s) => s.id !== exceptId && nameKey(s.name) === key) ?? null;
}

export const byName = (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });

/**
 * Turns schedule blocks from before subjects existed ({ subject: 'Cálculo',
 * color, day, start, end, place }) into subjects + blocks that point to them.
 * Blocks with the same name (ignoring case and spacing) become one subject,
 * which keeps the color of the first of them. Blocks that already have a
 * subjectId are left alone.
 *
 * @param {object[]} blocks
 * @param {object[]} [existing]  subjects already present (matched by name, ids not reused)
 * @returns {{ subjects: object[], blocks: object[] }}  only the new subjects; every block
 */
export function subjectsFromLegacyBlocks(blocks, existing = []) {
  const subjects = [];
  const byKey = new Map(existing.map((s) => [nameKey(s.name), s]));
  let nextId = Math.max(0, ...existing.map((s) => s.id)) + 1;
  const now = new Date().toISOString();

  const migrated = blocks.map((block) => {
    if (block.subjectId != null) return block;
    const name = cleanName(String(block.subject ?? '')) || 'Sin nombre';
    let subject = byKey.get(nameKey(name));
    if (!subject) {
      subject = { id: nextId++, name, color: validColor(block.color), createdAt: block.createdAt ?? now };
      byKey.set(nameKey(name), subject);
      subjects.push(subject);
    }
    // eslint-disable-next-line no-unused-vars
    const { subject: _name, color: _color, ...rest } = block;
    return { ...rest, subjectId: subject.id };
  });

  return { subjects, blocks: migrated };
}
