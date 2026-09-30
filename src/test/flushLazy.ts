// Test helper for React.lazy-backed components.
//
// The markdown pipeline (react-markdown + remark/rehype plugins) loads through
// a dynamic import (see components/common/LazyMarkdown), so parsed nodes are
// not in the DOM on the first synchronous render. A test that renders a message
// and immediately asserts on its text needs this flush first.
//
// Wrap the assertions — not the render — because the flush re-renders
// everything currently mounted.
import { act } from "@testing-library/react";

/** Resolve any pending lazy chunk and let React commit the result.
 *
 *  The chat markdown chunk awaits FIVE dynamic imports (react-markdown plus the
 *  remark/rehype plugins), so settling them takes several rounds of microtask →
 *  macrotask → re-render. Loop rather than assume a fixed number of ticks. */
export async function flushLazy(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop -- each turn drains one more link of the import chain
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
  }
}
