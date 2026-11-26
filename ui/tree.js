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

  // Keeps the in-progress list valid after any edit, so the orb never names a
  // finished or deleted task. When every task in the list has been finished or
  // deleted, the next open task takes over, as the natural thing to do next.
  // A list the user emptied on purpose stays empty.
  function resolveActiveIds(tasks, ids) {
    const valid = ids.filter((id, i) => {
      const t = ids.indexOf(id) === i && findTask(tasks, id);
      return t && !t.done;
    });
    if (valid.length > 0 || ids.length === 0) return valid;
    const next = firstOpenTask(tasks);
    return next ? [next.id] : [];
  }

  // The given ids in the order their tasks appear in the tree.
  function inTreeOrder(tasks, ids) {
    const wanted = new Set(ids);
    const out = [];
    (function walk(nodes) {
      for (const n of nodes) {
        if (wanted.has(n.id)) out.push(n.id);
        walk(n.children);
      }
    })(tasks);
    return out;
  }

  // When a deadline passes: "YYYY-MM-DD" at the end of that local day,
  // "YYYY-MM-DDTHH:MM" at that local minute. Null when there is none, or it
  // can't be read.
  function deadlineMoment(deadline) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(deadline || "");
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    return m[4] === undefined ? new Date(y, mo, d + 1) : new Date(y, mo, d, Number(m[4]), Number(m[5]));
  }

  // A finished task is never overdue.
  function isOverdue(task, now) {
    if (task.done) return false;
    const due = deadlineMoment(task.deadline);
    return due !== null && now >= due;
  }

  function anyOverdue(tasks, ids, now) {
    return ids.some((id) => {
      const t = findTask(tasks, id);
      return t && isOverdue(t, now);
    });
  }

  const api = {
    findTask,
    deleteTask,
    setDone,
    firstOpenTask,
    resolveActiveIds,
    inTreeOrder,
    deadlineMoment,
    isOverdue,
    anyOverdue,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TaskTree = api;
})(this);
