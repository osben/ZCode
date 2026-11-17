//! The sandbox child's command line and environment (specs/fork-rust-workflow-engine.md, 4.1; Q9).

use std::path::Path;

use super::*;

fn helper_command() -> ChildCommand {
    ChildCommand {
        program: "/Applications/ZCode.app/Contents/MacOS/ZCode Helper".to_owned(),
        env: vec![
            ("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned()),
            ("ZCODE_EXAMPLE".to_owned(), "kept".to_owned()),
        ],
    }
}

#[test]
fn the_child_runs_the_helper_program_with_the_heap_cap_and_the_entry_file() {
    let invocation = invocation(
        &helper_command(),
        Path::new("/work/.zcode/workflow-runs/run-1.mjs"),
    );
    assert_eq!(
        invocation.program,
        "/Applications/ZCode.app/Contents/MacOS/ZCode Helper"
    );
    assert_eq!(
        invocation.args,
        vec![
            "--max-old-space-size=256".to_owned(),
            "/work/.zcode/workflow-runs/run-1.mjs".to_owned(),
        ]
    );
}

#[test]
fn the_child_environment_keeps_the_helper_env_and_always_sets_run_as_node() {
    let spawned = invocation(&helper_command(), Path::new("/tmp/run.mjs"));
    assert!(
        spawned
            .env
            .contains(&("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned()))
    );
    assert!(
        spawned
            .env
            .contains(&("ZCODE_EXAMPLE".to_owned(), "kept".to_owned()))
    );
    // A helper command without the variable still gets it: the Electron helper binary needs it to act as Node.
    let bare = ChildCommand {
        program: "node".to_owned(),
        env: Vec::new(),
    };
    assert!(
        invocation(&bare, Path::new("/tmp/run.mjs"))
            .env
            .contains(&("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned()))
    );
}

#[test]
fn the_command_never_carries_the_bundle_argument() {
    // The entry file is self-contained (renderChildEntry), so the helper bundle is not an argument of the child.
    let invocation = invocation(&helper_command(), Path::new("/tmp/run.mjs"));
    assert!(invocation.args.iter().all(|arg| !arg.contains("__zcode")));
    assert_eq!(invocation.args.len(), 2);
}
