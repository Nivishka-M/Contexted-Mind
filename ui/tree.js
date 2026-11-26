// Pure task-tree operations, shared by the app and tests/tree.test.js.
(function (root) {
  function findTask(nodes, id) {
    for (const n of nodes) {
      if (n.id === id) return n;
      const found = findTask(n.children, id);
      if (found) return found;
    }
    return null;
  }

  function deleteTask(nodes, id) {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx !== -1) {
      nodes.splice(idx, 1);
      return true;
    }
    return nodes.some((n) => deleteTask(n.children, id));
  }

  // Marks a task and everything under it, since a finished parent has no open work.
  function setDone(node, done) {
    node.done = done;
    if (done) node.children.forEach((c) => setDone(c, true));
  }

  // First unfinished task in tree order: the natural thing to work on next.
  function firstOpenTask(nodes) {
    for (const n of nodes) {
      if (n.done) continue;
      return firstOpenTask(n.children) || n;
    }
    return null;
  }

  // Keeps the current task valid after any edit, so the orb never names a
  // finished or deleted task.
  function resolveActiveId(tasks, activeId) {
    const active = activeId ? findTask(tasks, activeId) : null;
    if (active && !active.done) return activeId;
    const next = firstOpenTask(tasks);
    return next ? next.id : null;
  }

  // The sibling list holding a task, and the tasks above it, nearest first.
  function locate(nodes, id, ancestors = []) {
    const index = nodes.findIndex((n) => n.id === id);
    if (index !== -1) return { list: nodes, index, ancestors };
    for (const n of nodes) {
      const found = locate(n.children, id, [n, ...ancestors]);
      if (found) return found;
    }
    return null;
  }

  // Moves a task, with its subtasks, to just before or after another task,
  // which may sit at a different level. Refuses to move a task into its own
  // subtree. An open task landing under finished parents reopens them, since
  // they have open work again.
  function moveTask(tasks, id, targetId, place) {
    if (id === targetId) return false;
    const from = locate(tasks, id);
    if (!from || findTask(from.list[from.index].children, targetId)) return false;
    if (!locate(tasks, targetId)) return false;
    const [node] = from.list.splice(from.index, 1);
    const to = locate(tasks, targetId);
    to.list.splice(place === "after" ? to.index + 1 : to.index, 0, node);
    if (!node.done) to.ancestors.forEach((a) => (a.done = false));
    return true;
  }

  // Moves a task one place up (-1) or down (+1) among its siblings.
  function shiftTask(tasks, id, delta) {
    const from = locate(tasks, id);
    if (!from) return false;
    const to = from.index + delta;
    if (to < 0 || to >= from.list.length) return false;
    const [node] = from.list.splice(from.index, 1);
    from.list.splice(to, 0, node);
    return true;
  }

  const api = { findTask, deleteTask, setDone, firstOpenTask, resolveActiveId, moveTask, shiftTask };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TaskTree = api;
})(this);
