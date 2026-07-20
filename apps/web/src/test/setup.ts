import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const localValues = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return localValues.size;
  },
  clear: () => localValues.clear(),
  getItem: (key) => localValues.get(String(key)) ?? null,
  key: (index) => Array.from(localValues.keys())[index] ?? null,
  removeItem: (key) => localValues.delete(String(key)),
  setItem: (key, value) => localValues.set(String(key), String(value)),
};

// Node 24+ exposes an unusable localStorage getter unless a persistence file
// is configured. Tests need deterministic, isolated browser storage instead.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: testLocalStorage,
});

afterEach(() => cleanup());
