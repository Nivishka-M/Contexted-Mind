const { invoke } = window.__TAURI__.core;
const { findTask, deleteTask, setDone, resolveActiveId } = window.TaskTree;

let appData = { active_task_id: null, tasks: [] };
let currentMode = "pill";
let cardFlipped = false;
let hoverCollapseTimer = null;
// Mode changes run one at a time, so a quick hover-then-click can't interleave
// window resizes on the Rust side.
let modeQueue = Promise.resolve();

const el = (id) => document.getElementById(id);

function syncHeaderText() {
  const active = appData.active_task_id && findTask(appData.tasks, appData.active_task_id);
  document.body.classList.toggle("no-task", !active);
  if (active) {
    el("hover-task-name").textContent = active.title;
    el("hover-subtext").textContent = "is your current task · Click to edit";
    el("modal-active-task").textContent = active.title;
  } else {
    el("hover-task-name").textContent = "No current task";
    el("hover-subtext").textContent = "Click to add one";
    el("modal-active-task").textContent = "None. Add a task or pick one with Focus.";
  }
}

async function persist() {
  appData.active_task_id = resolveActiveId(appData.tasks, appData.active_task_id);
  syncHeaderText();
  await invoke("save_tree", {
    update: { active_task_id: appData.active_task_id, tasks: appData.tasks },
  });
}

// --- View modes ---
function switchMode(mode) {
  modeQueue = modeQueue.then(() => applyMode(mode)).catch(console.error);
  return modeQueue;
}

async function applyMode(mode) {
  if (currentMode === mode) return;
  const result = await invoke("set_view_mode", { mode, flipped: cardFlipped });
  currentMode = mode;
  cardFlipped = result.flipped;
  document.body.className = `mode-${mode}`;
  document.body.classList.toggle("flipped", cardFlipped);
  syncHeaderText();

  const snapshot = el("desktop-snapshot");
  if (mode === "modal") {
    if (result.background) {
      snapshot.src = result.background;
      snapshot.classList.add("loaded");
    }
    renderTree();
    el("new-root-input").focus();
  } else {
    // Don't keep a picture of the desktop in memory once the tree is closed.
    snapshot.removeAttribute("src");
    snapshot.classList.remove("loaded");
  }
}

const compactContainer = el("compact-container");
const orb = el("orb");

orb.addEventListener("mouseenter", () => {
  clearTimeout(hoverCollapseTimer);
  if (currentMode === "pill") switchMode("hover");
});

compactContainer.addEventListener("mouseenter", () => clearTimeout(hoverCollapseTimer));

function scheduleCollapse() {
  clearTimeout(hoverCollapseTimer);
  hoverCollapseTimer = setTimeout(() => {
    if (currentMode === "hover") switchMode("pill");
  }, 220);
}

compactContainer.addEventListener("mouseleave", scheduleCollapse);
document.documentElement.addEventListener("mouseleave", scheduleCollapse);

orb.addEventListener("click", (e) => {
  if (e.target.id === "drag-handle") return;
  clearTimeout(hoverCollapseTimer);
  switchMode("modal");
});

el("hover-banner").addEventListener("click", () => {
  clearTimeout(hoverCollapseTimer);
  switchMode("modal");
});

el("btn-close-modal").addEventListener("click", closeModal);
el("btn-quit").addEventListener("click", () => invoke("quit_app"));

el("blur-layer").addEventListener("click", (e) => {
  if (e.target.id === "blur-layer") closeModal();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && currentMode === "modal") closeModal();
});

async function closeModal() {
  // A title being typed only commits on blur; do it before the tree disappears.
  if (document.activeElement) document.activeElement.blur();
  await switchMode("pill");
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
  const isActive = appData.active_task_id === node.id;
  const wrapper = document.createElement("div");
  wrapper.className = "tree-node";

  const row = document.createElement("div");
  row.className = "task-row" + (isActive ? " is-active" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "task-checkbox";
  cb.checked = node.done;
  cb.setAttribute("aria-label", `Mark "${node.title}" done`);
  cb.addEventListener("change", async () => {
    setDone(node, cb.checked);
    await commit();
  });

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
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const focusBtn = iconButton(
    isActive ? "★ Current" : "☆ Focus",
    "Set as current task",
    isActive ? "active-focus" : "",
    async () => {
      appData.active_task_id = node.id;
      await commit();
    }
  );
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

  actions.append(focusBtn, subBtn, delBtn);
  row.append(cb, input, actions);
  wrapper.appendChild(row);

  if (node.children.length > 0) {
    const children = document.createElement("div");
    children.className = "tree-children";
    node.children.forEach((child) => children.appendChild(buildNodeElement(child)));
    wrapper.appendChild(children);
  }
  return wrapper;
}

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

async function addRootTask() {
  const input = el("new-root-input");
  const title = input.value.trim();
  if (!title) return;
  appData.tasks.push(newTask(title));
  input.value = "";
  await commit();
}

el("btn-add-root").addEventListener("click", addRootTask);
el("new-root-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addRootTask();
});

(async () => {
  appData = await invoke("get_state");
  syncHeaderText();
})();
