import type { Direction } from "./types";

const STORAGE_KEY = "factory-traffic-sequence-v1";
const fallbackSequences: Record<Direction, number> = { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 };

export function nextSequence(direction: Direction, backendSequence = 0): number {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const previous = getDirectionValue(stored, direction);
    const storedNumber = typeof previous === "number" && Number.isSafeInteger(previous) ? previous : 0;
    const next = Math.max(storedNumber, fallbackSequences[direction], backendSequence) + 1;
    const updated = {
      NORTH: direction === "NORTH" ? next : getStoredSequence(stored, "NORTH"),
      SOUTH: direction === "SOUTH" ? next : getStoredSequence(stored, "SOUTH"),
      EAST: direction === "EAST" ? next : getStoredSequence(stored, "EAST"),
      WEST: direction === "WEST" ? next : getStoredSequence(stored, "WEST"),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    fallbackSequences[direction] = next;
    return next;
  } catch {
    fallbackSequences[direction] += 1;
    return fallbackSequences[direction];
  }
}

function getStoredSequence(value: unknown, direction: Direction): number {
  const stored = getDirectionValue(value, direction);
  return typeof stored === "number" && Number.isSafeInteger(stored) ? stored : 0;
}

function getDirectionValue(value: unknown, direction: Direction): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, direction);
}
