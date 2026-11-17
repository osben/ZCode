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
    let spawned = invocation(
        &helper_command(),
        Path::new("/work/.zcode/workflow-runs/run-1.mjs"),
    );
    assert_eq!(
        spawned.program,
        "/Applications/ZCode.app/Contents/MacOS/ZCode Helper"
    );
    assert_eq!(
        spawned.args,
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
fn a_helper_env_with_another_run_as_node_value_is_replaced_by_exactly_one_entry() {
    let command = ChildCommand {
        program: "node".to_owned(),
        env: vec![("ELECTRON_RUN_AS_NODE".to_owned(), "0".to_owned())],
    };
    let spawned = invocation(&command, Path::new("/tmp/run.mjs"));
    let values: Vec<&String> = spawned
        .env
        .iter()
        .filter(|(name, _)| name == "ELECTRON_RUN_AS_NODE")
        .map(|(_, value)| value)
        .collect();
    assert_eq!(
        values,
        vec!["1"],
        "the override is the only ELECTRON_RUN_AS_NODE entry"
    );
}

#[test]
fn the_command_never_carries_the_bundle_argument() {
    // The entry file is self-contained (renderChildEntry), so the helper bundle is not an argument of the child.
    let spawned = invocation(&helper_command(), Path::new("/tmp/run.mjs"));
    assert!(spawned.args.iter().all(|arg| !arg.contains("__zcode")));
    assert_eq!(spawned.args.len(), 2);
}

#[test]
fn the_invocation_debug_names_the_env_without_its_values() {
    let spawned = invocation(&helper_command(), Path::new("/tmp/run.mjs"));
    let debug = format!("{spawned:?}");
    assert!(debug.contains("ZCODE_EXAMPLE"), "{debug}");
    assert!(
        !debug.contains("kept"),
        "no env value reaches a log: {debug}"
    );
    assert!(!format!("{:?}", helper_command()).contains("kept"));
}
