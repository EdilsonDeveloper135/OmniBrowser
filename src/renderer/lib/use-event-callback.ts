import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A callback whose identity never changes but that always runs the latest `handler`. Memoized children can receive it
 * without re-rendering every time the parent does. It is for event handlers: calling it during render would run the
 * handler of the previous commit.
 */
export function useEventCallback<Args extends unknown[], Result>(handler: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
