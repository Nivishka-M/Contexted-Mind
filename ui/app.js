const { invoke } = window.__TAURI__.core;
const {
  findTask,
  deleteTask,
  setDone,
  resolveActiveIds,
  inTreeOrder,
  deadlineMoment,
  isOverdue,
  anyOverdue,
  moveTask,
  shiftTask,
} = window.TaskTree;

// One page serves two windows: the small transparent orb ("main") and the
// opaque fullscreen tree ("tree"), which Rust creates when the orb is clicked.
const isTree = window.__TAURI__.window.getCurrentWindow().label === "tree";

let appData = { active_task_ids: [], tasks: [] };
// Tasks whose deadline editor is open, kept across re-renders.
const openDeadlineEditors = new Set();
// Orb window only: "pill", "hover" or "tree" (tree window open, orb hidden).
let currentMode = "pill";
// The mode the queue is heading to. Hiding the orb while the tree opens fires
// mouseleave; checking currentMode alone would queue a stray collapse.
let targetMode = "pill";
let cardFlipped = false;
let hoverCollapseTimer = null;
// Mode changes run one at a time, so a quick hover-then-click can't interleave
// window resizes on the Rust side.
let modeQueue = Promise.resolve();
// The last save, so closing the tree can wait for an edit committed on blur.
let lastSave = Promise.resolve();

const el = (id) => document.getElementById(id);

function syncHeaderText() {
  const ids = inTreeOrder(appData.tasks, appData.active_task_ids);
  const titles = ids.map((id) => findTask(appData.tasks, id).title);
  const overdue = anyOverdue(appData.tasks, ids, new Date());
  document.body.classList.toggle("no-task", titles.length === 0);
  document.body.classList.toggle("has-overdue", overdue);
  if (titles.length > 0) {
    const more = titles.length - 1;
    el("hover-task-name").textContent = titles[0];
    el("hover-subtext").textContent =
      (overdue ? "⚠ Past deadline · " : "") +
      (more > 0 ? `+${more} more in progress` : "is in progress") +
      " · Click to edit";
    el("modal-active-task").textContent = titles.join("  ·  ");
  } else {
    el("hover-task-name").textContent = "Nothing in progress";
    el("hover-subtext").textContent = "Click to add or pick a task";
    el("modal-active-task").textContent = "Nothing yet. Add a task or pick some with Focus.";
  }
}

function persist() {
  appData.active_task_ids = resolveActiveIds(appData.tasks, appData.active_task_ids);
  syncHeaderText();
  lastSave = invoke("save_tree", {
    update: { active_task_ids: appData.active_task_ids, tasks: appData.tasks },
  });
  return lastSave;
}

// --- Orb window ---
function switchMode(mode) {
  targetMode = mode;
  if (mode !== "hover") clearTimeout(hoverCollapseTimer);
  modeQueue = modeQueue.then(() => applyMode(mode)).catch(console.error);
  return modeQueue;
}

async function applyMode(mode) {
  if (currentMode === mode) return;
  if (mode === "tree") {
    currentMode = "tree";
    try {
      await invoke("open_tree", { flipped: cardFlipped });
    } catch (err) {
      console.error(err);
      setPill();
    }
    return;
  }
  const result = await invoke("set_view_mode", { mode, flipped: cardFlipped });
  currentMode = mode;
  cardFlipped = result.flipped;
  document.body.className = `mode-${mode}`;
  document.body.classList.toggle("flipped", cardFlipped);
  syncHeaderText();
  updateHitRegion();
}

// Tells Rust which parts of the orb window take clicks. The orb's window is a
// square with see-through corners, and clicks there should reach whatever is
// underneath. Only applied on Linux.
function updateHitRegion() {
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  // With the card open the whole window takes clicks: it is barely larger
  // than the card, and WebKit sends no mouseleave when the pointer exits
  // through a click-through part of the window, so the card wouldn't close.
  const shapes = document.body.classList.contains("mode-hover")
    ? [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, round: false }]
    : [
        { ...box(el("orb")), round: true },
        { ...box(el("drag-handle")), round: true },
      ];
  invoke("set_hit_region", { shapes }).catch(console.error);
}

function setPill() {
  currentMode = "pill";
  targetMode = "pill";
  cardFlipped = false;
  document.body.className = "mode-pill";
  syncHeaderText();
  updateHitRegion();
}

function setupOrb() {
  const compactContainer = el("compact-container");
  const orb = el("orb");

  // mousemove as well as mouseenter: the orb hides while the pointer is on it
  // (to open the tree), so WebKit may never see it leave and then skips the
  // next mouseenter when the orb comes back.
  const expand = () => {
    clearTimeout(hoverCollapseTimer);
    if (targetMode === "pill") switchMode("hover");
  };
  orb.addEventListener("mouseenter", expand);
  orb.addEventListener("mousemove", expand);

  compactContainer.addEventListener("mouseenter", () => clearTimeout(hoverCollapseTimer));

  function scheduleCollapse() {
    clearTimeout(hoverCollapseTimer);
    hoverCollapseTimer = setTimeout(() => {
      if (targetMode === "hover") switchMode("pill");
    }, 220);
  }

  compactContainer.addEventListener("mouseleave", scheduleCollapse);
  document.documentElement.addEventListener("mouseleave", scheduleCollapse);

  orb.addEventListener("click", (e) => {
    if (e.target.id === "drag-handle") return;
    switchMode("tree");
  });

  el("hover-banner").addEventListener("click", () => switchMode("tree"));

  // Rust shows the orb again when the tree window closes; pick up any edits.
  window.__TAURI__.event.listen("tree-closed", async () => {
    appData = await invoke("get_state");
    modeQueue = modeQueue.then(setPill);
  });
}

// --- Tree window ---
async function closeTree() {
  // A title being typed only commits on blur; let that save land first.
  if (document.activeElement) document.activeElement.blur();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await lastSave.catch(console.error);
  await invoke("close_tree");
}

function setupTree() {
  document.body.className = "mode-modal";
  el("btn-close-modal").addEventListener("click", closeTree);
  el("btn-quit").addEventListener("click", () => invoke("quit_app"));
  el("blur-layer").addEventListener("click", (e) => {
    if (e.target.id === "blur-layer") closeTree();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (drag) cancelDrag();
    else closeTree();
  });
}

// --- Tree rendering and edits ---
function uid() {
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function newTask(title) {
  return { id: uid(), title, done: false, children: [] };
}

async function commit() {
  await persist();
  renderTree();
}

function iconButton(label, title, className, onClick) {
  const btn = document.createElement("button");
  btn.className = `icon-btn ${className}`.trim();
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

function buildNodeElement(node) {
  const isActive = appData.active_task_ids.includes(node.id);
  const wrapper = document.createElement("div");
  wrapper.className = "tree-node";

  const row = document.createElement("div");
  row.className = "task-row" + (isActive ? " is-active" : "");
  row.dataset.rowId = node.id;

  const grip = document.createElement("div");
  grip.className = "drag-grip";
  grip.textContent = "⋮⋮";
  grip.title = "Drag to reorder. Or Alt+↑ / Alt+↓ while editing the title.";
  grip.addEventListener("pointerdown", (e) => startDrag(e, node.id, row));

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "task-checkbox";
  cb.checked = node.done;
  cb.setAttribute("aria-label", `Mark "${node.title}" done`);
  cb.addEventListener("change", async () => {
    setDone(node, cb.checked);
    await commit();
  });

  const overdueIcon = document.createElement("span");
  overdueIcon.className = "overdue-icon";
  overdueIcon.textContent = "!";
  overdueIcon.setAttribute("role", "img");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "task-title-input" + (node.done ? " done" : "");
  input.value = node.title;
  input.dataset.taskId = node.id;
  input.addEventListener("change", async () => {
    node.title = input.value.trim() || "Untitled task";
    input.value = node.title;
    await persist();
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") input.blur();
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      // Keep a title edit that hasn't been committed yet.
      node.title = input.value.trim() || node.title;
      if (shiftTask(appData.tasks, node.id, e.key === "ArrowUp" ? -1 : 1)) {
        await commit();
        const moved = document.querySelector(`[data-task-id="${node.id}"]`);
        if (moved) moved.focus();
      }
    }
  });

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const focusBtn = iconButton(
    isActive ? "★ In progress" : "☆ Focus",
    isActive ? "Stop working on this task" : "Mark as in progress, alongside any others",
    isActive ? "active-focus" : "",
    async () => {
      appData.active_task_ids = isActive
        ? appData.active_task_ids.filter((id) => id !== node.id)
        : [...appData.active_task_ids, node.id];
      await commit();
    }
  );

  const dueBtn = iconButton("Due", "", "deadline-btn", () => {
    if (openDeadlineEditors.has(node.id)) openDeadlineEditors.delete(node.id);
    else openDeadlineEditors.add(node.id);
    renderTree();
  });
  focusBtn.disabled = node.done;

  const subBtn = iconButton("+ Subtask", "Add a subtask", "", async () => {
    const sub = newTask("New subtask");
    node.children.push(sub);
    // A new open child means the parent isn't finished any more.
    node.done = false;
    await commit();
    const subInput = document.querySelector(`[data-task-id="${sub.id}"]`);
    if (subInput) subInput.select();
  });

  const delBtn = iconButton("✕", "Delete task and its subtasks", "delete", async () => {
    deleteTask(appData.tasks, node.id);
    await commit();
  });

  actions.append(dueBtn, focusBtn, subBtn, delBtn);
  row.append(grip, cb, overdueIcon, input, actions);
  row.dataset.deadlineFor = node.id;
  paintDeadline(row, node);
  wrapper.appendChild(row);
  if (openDeadlineEditors.has(node.id)) wrapper.appendChild(buildDeadlineEditor(node, row));

  if (node.children.length > 0) {
    const children = document.createElement("div");
    children.className = "tree-children";
    node.children.forEach((child) => children.appendChild(buildNodeElement(child)));
    wrapper.appendChild(children);
  }
  return wrapper;
}

// --- Deadlines ---
function formatDeadline(deadline) {
  const due = deadlineMoment(deadline);
  if (!due) return "";
  const hasTime = deadline.includes("T");
  // A date-only deadline ends at the following midnight; show the day itself.
  const day = hasTime ? due : new Date(due.getTime() - 1);
  const opts = { month: "short", day: "numeric" };
  if (day.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  let text = day.toLocaleDateString(undefined, opts);
  if (hasTime) text += ", " + day.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return text;
}

// Updates a row's deadline button and overdue mark without re-rendering, so
// it can run on a timer and while the deadline editor has focus.
function paintDeadline(row, node) {
  const btn = row.querySelector(".deadline-btn");
  const overdue = isOverdue(node, new Date());
  row.classList.toggle("overdue", overdue);
  btn.classList.toggle("has-deadline", Boolean(node.deadline));
  btn.textContent = node.deadline ? `Due ${formatDeadline(node.deadline)}` : "Due";
  btn.title = node.deadline ? "Change or clear the deadline" : "Set a deadline";
  row.querySelector(".overdue-icon").title = overdue
    ? `Past its deadline (${formatDeadline(node.deadline)})`
    : "";
}

function buildDeadlineEditor(node, row) {
  const editor = document.createElement("div");
  editor.className = "deadline-editor";

  const [datePart, timePart] = (node.deadline || "").split("T");
  const date = document.createElement("input");
  date.type = "date";
  date.value = datePart || "";
  date.setAttribute("aria-label", "Deadline date");
  const time = document.createElement("input");
  time.type = "time";
  time.value = timePart || "";
  time.setAttribute("aria-label", "Deadline time (optional)");

  const save = async () => {
    if (date.value) node.deadline = time.value ? `${date.value}T${time.value}` : date.value;
    else delete node.deadline;
    paintDeadline(row, node);
    await persist();
  };
  date.addEventListener("change", save);
  time.addEventListener("change", save);

  const label = document.createElement("span");
  label.className = "deadline-label";
  label.textContent = "Deadline";
  const hint = document.createElement("span");
  hint.className = "deadline-hint";
  hint.textContent = "Time optional: without one it's due by the end of the day.";

  const clear = iconButton("Clear", "Remove the deadline", "", async () => {
    delete node.deadline;
    openDeadlineEditors.delete(node.id);
    await commit();
  });
  const done = iconButton("Done", "Close the deadline editor", "", () => {
    openDeadlineEditors.delete(node.id);
    renderTree();
  });

  editor.append(label, date, time, clear, done, hint);
  return editor;
}

// Deadlines pass while the app sits open; check every half minute.
setInterval(() => {
  document.querySelectorAll("[data-deadline-for]").forEach((row) => {
    const node = findTask(appData.tasks, row.dataset.deadlineFor);
    if (node) paintDeadline(row, node);
  });
  syncHeaderText();
}, 30000);

function renderTree() {
  const container = el("tree-container");
  container.replaceChildren();
  if (appData.tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "Nothing here yet. Add the task you're working on.";
    container.appendChild(empty);
  } else {
    appData.tasks.forEach((t) => container.appendChild(buildNodeElement(t)));
  }
  syncHeaderText();
}

// --- Drag to reorder ---
// Pointer events rather than HTML5 drag and drop, which WebKitGTK handles
// unreliably. Dropping on the top or bottom half of a row places the dragged
// task (with its subtasks) above or below that row, at that row's level.
let drag = null;

function startDrag(e, id, row) {
  if (e.button !== 0) return;
  e.preventDefault();
  // Commit a title being edited before the tree re-renders.
  if (document.activeElement) document.activeElement.blur();
  drag = { id, row, target: null, place: null };
  row.classList.add("dragging");
  document.body.classList.add("is-dragging");
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
}

function clearDropMarker() {
  if (drag && drag.target) drag.target.classList.remove("drop-before", "drop-after");
}

function onDragMove(e) {
  if (!drag) return;
  autoScroll(e.clientY);
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const row = hit && hit.closest(".task-row");
  // Not onto itself or anything inside it.
  const valid = row && !drag.row.parentElement.contains(row);
  const rect = valid && row.getBoundingClientRect();
  const place = valid && e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  if (valid && row === drag.target && place === drag.place) return;
  clearDropMarker();
  drag.target = valid ? row : null;
  drag.place = valid ? place : null;
  if (valid) row.classList.add(place === "before" ? "drop-before" : "drop-after");
}

function autoScroll(y) {
  const box = el("tree-container");
  const r = box.getBoundingClientRect();
  if (y < r.top + 32) box.scrollTop -= 12;
  else if (y > r.bottom - 32) box.scrollTop += 12;
}

function endDrag() {
  clearDropMarker();
  drag.row.classList.remove("dragging");
  document.body.classList.remove("is-dragging");
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  const done = drag;
  drag = null;
  return done;
}

function cancelDrag() {
  if (drag) endDrag();
}

async function onDragEnd() {
  if (!drag) return;
  const { id, target, place } = endDrag();
  if (target && moveTask(appData.tasks, id, target.dataset.rowId, place)) {
    await commit();
  }
}

async function addRootTask() {
  const input = el("new-root-input");
  const title = input.value.trim();
  if (!title) return;
  const task = newTask(title);
  appData.tasks.push(task);
  // With nothing in progress, a new task is the obvious thing to work on.
  if (appData.active_task_ids.length === 0) appData.active_task_ids.push(task.id);
  input.value = "";
  await commit();
}

el("btn-add-root").addEventListener("click", addRootTask);
el("new-root-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addRootTask();
});

(async () => {
  if (isTree) setupTree();
  else {
    setupOrb();
    updateHitRegion();
    // The card's size is only final once the window has grown to fit it,
    // which can land after the mode change has been applied.
    window.addEventListener("resize", updateHitRegion);
  }
  appData = await invoke("get_state");
  syncHeaderText();
  if (isTree) {
    const background = await invoke("take_snapshot");
    if (background) {
      const snapshot = el("desktop-snapshot");
      snapshot.src = background;
      snapshot.classList.add("loaded");
    }
    renderTree();
    el("new-root-input").focus();
  }
})();
