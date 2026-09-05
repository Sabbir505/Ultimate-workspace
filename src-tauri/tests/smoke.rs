// Trivial integration test. It serves two purposes:
// 1. A sanity check that integration-test binaries (which link relay_lib and
//    thus also import comctl32!TaskDialogIndirect) build and run with the
//    comctl32-v6 manifest that build.rs embeds into every artifact.
// 2. It ensures the package always has a [[test]] target, keeping the
//    `cargo:rustc-link-arg-tests` build-script directive legal — a fallback
//    option if the all-artifact approach ever needs to be narrowed.
#[test]
fn smoke() {}
