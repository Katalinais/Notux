// Notes canvas: each card sits wherever the user drops it. A note's spot is
// saved as note.board = { x, y, z } (pixels from the board's top-left corner,
// z = stacking order). Notes that were never moved are laid out automatically
// in columns below the placed ones, so new notes never land on top of others.
//
// Moving a note: drag it with the mouse (from anywhere but its buttons, links
// or audio player); on touch screens, drag its grip so the rest of the card
// still scrolls the page; with the keyboard, focus the grip and use the arrows
// (Shift = bigger steps).
const GAP = 16;
const MIN_HEIGHT = 320;
const KEY_STEP = 16;
const KEY_STEP_BIG = 64;
const SAVE_DELAY = 500; // keyboard moves are saved once the arrows stop

const INTERACTIVE = 'button:not(.note-grip), a, audio, video, input, select, textarea';

/**
 * @param {HTMLElement} board
 * @param {{ onMove: (changes: { id: number, board: { x: number, y: number, z: number } }[]) => void }} options
 *   onMove gets every note whose spot changed: the moved one, plus the ones
 *   that were still auto-placed — they're pinned where they are now, so moving
 *   one note never makes the others jump.
 */
export function initNoteBoard(board, { onMove }) {
  let items = []; // [{ note, el }]
  let topZ = 0;
  let drag = null;
  let layoutQueued = false;

  // Cards change height when photos load or the window resizes the columns.
  const resizeObserver = new ResizeObserver(() => queueLayout());
  resizeObserver.observe(board);

  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layout();
    });
  }

  const place = (el, x, y) => {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  function fitHeight() {
    let bottom = 0;
    for (const { el } of items) bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
    board.style.height = `${Math.max(MIN_HEIGHT, bottom + GAP * 3)}px`;
  }

  function layout() {
    if (!items.length || drag) return;
    const cardW = items[0].el.offsetWidth;
    let bottom = 0;
    for (const { note, el } of items) {
      if (!note.board) continue;
      place(el, note.board.x, note.board.y);
      el.style.zIndex = String(note.board.z ?? 0);
      bottom = Math.max(bottom, note.board.y + el.offsetHeight);
    }
    const free = items.filter((i) => !i.note.board);
    const cols = Math.max(1, Math.floor((board.clientWidth + GAP) / (cardW + GAP)));
    const startY = free.length < items.length ? bottom + GAP * 2 : 0;
    const heights = Array(cols).fill(startY);
    for (const { el } of free) {
      const col = heights.indexOf(Math.min(...heights));
      place(el, col * (cardW + GAP), heights[col]);
      el.style.zIndex = '0';
      heights[col] += el.offsetHeight + GAP;
    }
    fitHeight();
  }

  function render(nextItems) {
    for (const { el } of items) resizeObserver.unobserve(el);
    items = nextItems;
    topZ = Math.max(0, ...items.map((i) => i.note.board?.z ?? 0));
    board.replaceChildren(...items.map((i) => i.el));
    board.classList.toggle('is-empty', items.length === 0);
    if (!items.length) {
      board.style.height = '';
      return;
    }
    for (const { el } of items) resizeObserver.observe(el);
    layout();
  }

  function itemFor(el) {
    return items.find((i) => i.el === el);
  }

  function pinAutoPlaced(except) {
    const pinned = [];
    for (const other of items) {
      if (other === except || other.note.board) continue;
      other.note = { ...other.note, board: { x: other.el.offsetLeft, y: other.el.offsetTop, z: 0 } };
      pinned.push({ id: other.note.id, board: other.note.board });
    }
    return pinned;
  }

  function commit(item) {
    const pos = { x: item.el.offsetLeft, y: item.el.offsetTop, z: ++topZ };
    item.el.style.zIndex = String(pos.z);
    item.note = { ...item.note, board: pos };
    onMove([{ id: item.note.id, board: pos }, ...pinAutoPlaced(item)]);
  }

  /* ----- Pointer dragging ----- */
  board.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.note-card');
    if (!card || e.button !== 0 || e.target.closest(INTERACTIVE)) return;
    const onGrip = !!e.target.closest('.note-grip');
    if (e.pointerType !== 'mouse' && !onGrip) return; // touch: the body scrolls, the grip drags
    const item = itemFor(card);
    if (!item) return;
    e.preventDefault(); // no text selection while dragging…
    if (onGrip) e.target.closest('.note-grip').focus(); // …which also skips focusing the grip
    card.setPointerCapture(e.pointerId);
    drag = {
      item,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x0: card.offsetLeft,
      y0: card.offsetTop,
      moved: false,
    };
    card.style.zIndex = String(topZ + 1); // on top while it moves
  });

  board.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
    if (!drag.moved) {
      drag.moved = true;
      drag.item.el.classList.add('is-dragging');
    }
    place(drag.item.el, Math.max(0, Math.round(drag.x0 + dx)), Math.max(0, Math.round(drag.y0 + dy)));
    fitHeight(); // dragging past the bottom grows the board
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { item, moved, x0, y0 } = drag;
    drag = null;
    item.el.classList.remove('is-dragging');
    if (cancelled || !moved) {
      place(item.el, x0, y0);
      item.el.style.zIndex = String(item.note.board?.z ?? 0);
      return;
    }
    commit(item);
    queueLayout(); // unplaced notes may need to move below this one
  }
  board.addEventListener('pointerup', (e) => endDrag(e, false));
  board.addEventListener('pointercancel', (e) => endDrag(e, true));

  /* ----- Keyboard ----- */
  const pendingSaves = new Map(); // card element → timer
  board.addEventListener('keydown', (e) => {
    const grip = e.target.closest('.note-grip');
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!grip || !delta) return;
    e.preventDefault();
    const card = grip.closest('.note-card');
    const item = itemFor(card);
    if (!item) return;
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const x = Math.max(0, card.offsetLeft + delta[0] * step);
    const y = Math.max(0, card.offsetTop + delta[1] * step);
    // Keep the new spot in memory right away (a re-layout must not undo it),
    // and save once the arrows stop.
    const z = pendingSaves.has(card) ? item.note.board.z : ++topZ;
    item.note = { ...item.note, board: { x, y, z } };
    place(card, x, y);
    card.style.zIndex = String(z);
    fitHeight();
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    clearTimeout(pendingSaves.get(card));
    pendingSaves.set(
      card,
      setTimeout(() => {
        pendingSaves.delete(card);
        const current = itemFor(card);
        if (current) onMove([{ id: current.note.id, board: current.note.board }, ...pinAutoPlaced(current)]);
        queueLayout();
      }, SAVE_DELAY),
    );
  });

  // Scrolls a card into view and flashes it (e.g. a note just created).
  function reveal(id) {
    const item = items.find((i) => i.note.id === id);
    if (!item) return;
    item.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    item.el.classList.add('is-new');
    item.el.addEventListener('animationend', () => item.el.classList.remove('is-new'), { once: true });
  }

  return { render, reveal, layout: queueLayout };
}
