fn main() {
    tauri_build::build();

    // The conduit_lib test harness (and every other test target of this
    // package) links `comctl32!TaskDialogIndirect` (pulled in transitively by
    // the tauri dialog stack). That symbol only exists in comctl32 v6, which
    // the loader picks only when the process has an embedded application
    // manifest requesting Microsoft.Windows.Common-Controls 6.0. tauri-build
    // embeds such a manifest for the app binary (via rustc-link-arg-bins) but
    // not for test harnesses, so without this, test exes load legacy comctl32
    // 5.82 from WinSxS and die at load time with 0xC0000139
    // (STATUS_ENTRYPOINT_NOT_FOUND).
    //
    // Mechanism notes:
    // - `rustc-link-arg-tests` only reaches declared [[test]] targets
    //   (tests/smoke.rs), NOT the lib unit-test harness, so it is not enough.
    // - The manifest must therefore be linked into every artifact (plain
    //   `rustc-link-arg`). The app binary already gets an equivalent manifest
    //   from tauri-build, so without care the two would collide at link time
    //   (CVT1100 duplicate resource). comctl6.rc declares LANGUAGE 0, 0, making
    //   this resource (RT_MANIFEST, name 1, language 0) distinct from
    //   tauri-build's (language 0x0409) — no duplicate, and the loader prefers
    //   the language-specific manifest for the app while test exes (which have
    //   only the language-neutral one) fall back to it. Verified: an exe with
    //   this exact manifest embedded at language 0 lists all 289 tests.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile_for_everything("comctl6.rc", embed_resource::NONE)
            .manifest_required()
            .unwrap();
    }
}
