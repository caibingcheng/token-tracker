"use client";

import { useState, useEffect, useRef } from "react";

/**
 * Smoothly animates a number from current to target value.
 * Uses requestAnimationFrame with ease-out cubic easing.
 * 
 * @param target - The target number value
 * @param duration - Animation duration in ms (default: 600)
 * @returns The current animated value
 */
export function useAnimatedNumber(target: number, duration: number = 600): number {
  const [current, setCurrent] = useState(target);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef(target);
  const targetRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === targetRef.current) return;

    fromRef.current = current;
    targetRef.current = target;
    startRef.current = null;

    const animate = (timestamp: number) => {
      if (startRef.current === null) startRef.current = timestamp;
      const elapsed = timestamp - startRef.current;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out cubic: 1 - (1 - x)^3
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = fromRef.current + (target - fromRef.current) * eased;

      setCurrent(Math.round(value));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return current;
}
