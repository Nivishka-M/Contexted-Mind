// Run with: node --test tests/tree.test.js
const test = require("node:test");
const assert = require("node:assert");
const { findTask, deleteTask, setDone, firstOpenTask, resolveActiveId } = require("../ui/tree.js");

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
