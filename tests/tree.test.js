// Run with: node --test tests/tree.test.js
const test = require("node:test");
const assert = require("node:assert");
const {
  findTask,
  deleteTask,
  setDone,
  firstOpenTask,
  resolveActiveId,
  moveTask,
  shiftTask,
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

test("resolveActiveId keeps a valid task and replaces a finished or deleted one", () => {
  const tree = [task("a"), task("b", [], true)];
  assert.strictEqual(resolveActiveId(tree, "a"), "a");
  assert.strictEqual(resolveActiveId(tree, "b"), "a");
  assert.strictEqual(resolveActiveId(tree, "deleted"), "a");
  assert.strictEqual(resolveActiveId([], "a"), null);
});

const ids = (nodes) => nodes.map((n) => n.id);

test("moveTask reorders siblings before and after", () => {
  const tree = [task("a"), task("b"), task("c")];
  assert.ok(moveTask(tree, "c", "a", "before"));
  assert.deepStrictEqual(ids(tree), ["c", "a", "b"]);
  assert.ok(moveTask(tree, "c", "b", "after"));
  assert.deepStrictEqual(ids(tree), ["a", "b", "c"]);
});

test("moveTask carries subtasks to another level", () => {
  const tree = [task("a", [task("a1")]), task("b", [task("b1", [task("x")])])];
  assert.ok(moveTask(tree, "b1", "a1", "after"));
  assert.deepStrictEqual(ids(tree[0].children), ["a1", "b1"]);
  assert.deepStrictEqual(ids(findTask(tree, "b1").children), ["x"]);
  assert.deepStrictEqual(tree[1].children, []);
});

test("moveTask refuses to put a task inside itself", () => {
  const tree = [task("a", [task("b", [task("c")])])];
  assert.ok(!moveTask(tree, "a", "c", "before"));
  assert.ok(!moveTask(tree, "a", "a", "before"));
  assert.ok(!moveTask(tree, "a", "missing", "before"));
  assert.deepStrictEqual(ids(tree), ["a"]);
  assert.strictEqual(findTask(tree, "c").id, "c");
});

test("moveTask reopens finished parents that gain an open task", () => {
  const tree = [task("p", [task("q", [task("done-child", [], true)], true)], true), task("open")];
  assert.ok(moveTask(tree, "open", "done-child", "after"));
  assert.ok(!tree[0].done && !tree[0].children[0].done);
});

test("shiftTask moves within siblings and stops at the ends", () => {
  const tree = [task("a"), task("b", [task("b1"), task("b2")])];
  assert.ok(shiftTask(tree, "b2", -1));
  assert.deepStrictEqual(ids(tree[1].children), ["b2", "b1"]);
  assert.ok(!shiftTask(tree, "b2", -1));
  assert.ok(!shiftTask(tree, "b", 1));
  assert.ok(shiftTask(tree, "a", 1));
  assert.deepStrictEqual(ids(tree), ["b", "a"]);
});
