import assert from "node:assert/strict";
import test from "node:test";
import { computeRailScrollDelta } from "../../web/rail-scroll-utils";

test("returns null when pointer is inside rail bounds", () => {
  const delta = computeRailScrollDelta({
    railTop: 100,
    railBottom: 160,
    pointerY: 120,
    viewportCenterY: 300,
  });
  assert.equal(delta, null);
});

test("returns negative delta when pointer is above rail", () => {
  const delta = computeRailScrollDelta({
    railTop: 200,
    railBottom: 260,
    pointerY: 150,
  });
  assert.equal(delta, -80);
});

test("returns positive delta when pointer is below rail", () => {
  const delta = computeRailScrollDelta({
    railTop: 200,
    railBottom: 260,
    pointerY: 300,
  });
  assert.equal(delta, 70);
});

test("falls back to viewport center when pointer is unavailable", () => {
  const delta = computeRailScrollDelta({
    railTop: 100,
    railBottom: 140,
    pointerY: null,
    viewportCenterY: 200,
  });
  assert.equal(delta, 80);
});

test("returns null when delta is below epsilon", () => {
  const delta = computeRailScrollDelta({
    railTop: 100,
    railBottom: 140,
    pointerY: null,
    viewportCenterY: 120.2,
  });
  assert.equal(delta, null);
});

test("returns null for invalid geometry", () => {
  assert.equal(
    computeRailScrollDelta({
      railTop: Number.NaN,
      railBottom: 100,
      pointerY: 10,
    }),
    null,
  );
  assert.equal(
    computeRailScrollDelta({
      railTop: 200,
      railBottom: 150,
      pointerY: 10,
    }),
    null,
  );
});
