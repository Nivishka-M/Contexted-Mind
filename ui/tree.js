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

  const api = { findTask, deleteTask, setDone, firstOpenTask, resolveActiveId };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TaskTree = api;
})(this);
