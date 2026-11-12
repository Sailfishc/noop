import { Haptics, isAvailable } from "nsh/mobile";

/**
 * The one haptic Remi plays: a person's answer that moves the work on (accepting a result, deciding what an agent
 * asked), felt once as the answer lands. Phones only; elsewhere, and where the system won't play it, nothing.
 */
export function feelDone() {
  if (!isAvailable) return;
  try {
    Haptics.notification("success");
  } catch {
    /* no haptics here */
  }
}
