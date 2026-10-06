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
 *  Awaiting the SAME modules the lazy factories import makes this
 *  deterministic: the imports below share the module registry with
 *  LazyMarkdown, so once they resolve the factories' own `import()` calls are
 *  already settled. The previous implementation counted microtask → macrotask
 *  turns instead, which held on a dev machine but ran out of turns on a slow
 *  CI runner while the module graph was still transforming — that is why the
 *  suite was green locally and red in CI. The two `act` turns afterwards let
 *  React re-render the Suspense children that just became available and then
 *  settle whatever that render kicked off. */
export async function flushLazy(): Promise<void> {
  await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
    import("remark-breaks"),
    import("remark-math"),
    import("rehype-katex"),
  ]);
  for (let i = 0; i < 2; i++) {
    // eslint-disable-next-line no-await-in-loop -- one turn commits the lazy component, the next settles its render
    await act(async () => {
      await Promise.resolve();
    });
  }
}
