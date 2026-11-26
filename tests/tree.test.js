// Run with: node --test tests/tree.test.js
const test = require("node:test");
const assert = require("node:assert");
const {
  findTask,
  deleteTask,
  setDone,
  firstOpenTask,
  resolveActiveIds,
  inTreeOrder,
  deadlineMoment,
  isOverdue,
  anyOverdue,
} = require("../ui/tree.js");

const task = (id, children = [], done = false) => ({ id, title: id, done, children });

test("findTask reaches nested tasks", () => {
  const tree = [task("a", [task("b", [task("c")])])];
  assert.strictEqual(findTask(tree, "c").id, "c");
  assert.strictEqual(findTask(tree, "zzz"), null);
});

test("deleteTask removes a nested task and its subtree", () => {
  const tree = [task("a", [task("b", [task("c")])]), task("d")];
  assert.ok(deleteTask(tree, "b"));
  assert.strictEqual(findTask(tree, "c"), null);
  assert.ok(findTask(tree, "d"));
  assert.ok(!deleteTask(tree, "b"));
});

test("setDone cascades down when finishing, but not when reopening", () => {
  const b = task("b");
  const a = task("a", [b]);
  setDone(a, true);
  assert.ok(a.done && b.done);
  setDone(a, false);
  assert.ok(!a.done && b.done);
});

test("firstOpenTask prefers the deepest open task and skips finished branches", () => {
  const tree = [task("a", [task("b")], true), task("c", [task("d", [], true), task("e")])];
  assert.strictEqual(firstOpenTask(tree).id, "e");
  assert.strictEqual(firstOpenTask([task("x", [], true)]), null);
});

test("resolveActiveIds keeps open tasks and drops finished, deleted and repeated ones", () => {
  const tree = [task("a"), task("b", [], true), task("c")];
  assert.deepStrictEqual(resolveActiveIds(tree, ["c", "b", "gone", "c", "a"]), ["c", "a"]);
});

test("resolveActiveIds moves on to the next open task when all were finished", () => {
  const tree = [task("a", [], true), task("b")];
  assert.deepStrictEqual(resolveActiveIds(tree, ["a"]), ["b"]);
  assert.deepStrictEqual(resolveActiveIds([task("x", [], true)], ["x"]), []);
});

test("resolveActiveIds leaves a deliberately empty list empty", () => {
  assert.deepStrictEqual(resolveActiveIds([task("a")], []), []);
});

test("inTreeOrder follows the tree, not the list", () => {
  const tree = [task("a", [task("a1")]), task("b")];
  assert.deepStrictEqual(inTreeOrder(tree, ["b", "a1", "gone"]), ["a1", "b"]);
});

test("deadlineMoment reads dates as end of day and date-times as that minute", () => {
  assert.strictEqual(deadlineMoment("2026-03-09").getTime(), new Date(2026, 2, 10).getTime());
  assert.strictEqual(deadlineMoment("2026-12-31").getTime(), new Date(2027, 0, 1).getTime());
  assert.strictEqual(
    deadlineMoment("2026-03-09T14:05").getTime(),
    new Date(2026, 2, 9, 14, 5).getTime()
  );
  assert.strictEqual(deadlineMoment(undefined), null);
  assert.strictEqual(deadlineMoment("next tuesday"), null);
});

test("isOverdue only once the deadline has passed, and never for finished tasks", () => {
  const due = { ...task("a"), deadline: "2026-03-09" };
  assert.ok(!isOverdue(due, new Date(2026, 2, 9, 23, 59)));
  assert.ok(isOverdue(due, new Date(2026, 2, 10, 0, 0)));
  const timed = { ...task("b"), deadline: "2026-03-09T14:00" };
  assert.ok(!isOverdue(timed, new Date(2026, 2, 9, 13, 59)));
  assert.ok(isOverdue(timed, new Date(2026, 2, 9, 14, 0)));
  assert.ok(!isOverdue({ ...due, done: true }, new Date(2030, 0, 1)));
  assert.ok(!isOverdue(task("c"), new Date(2030, 0, 1)));
});

test("anyOverdue checks only the listed tasks", () => {
  const tree = [{ ...task("late"), deadline: "2020-01-01" }, task("fine")];
  const now = new Date(2026, 0, 1);
  assert.ok(anyOverdue(tree, ["fine", "late"], now));
  assert.ok(!anyOverdue(tree, ["fine"], now));
});
