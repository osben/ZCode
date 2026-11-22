use serde_json::Value;

use super::{LaunchTurn, WorkflowRunId};

fn turn(description: String, script: String) -> LaunchTurn {
    LaunchTurn {
        text: "run it".to_owned(),
        run_id: WorkflowRunId::new("run-1".to_owned()),
        tool_call_id: "call-1".to_owned(),
        name: "wf".to_owned(),
        scope: "project".to_owned(),
        path: "/p/wf.js".to_owned(),
        args: None,
        description,
        display: None,
        script,
    }
}

/// 9.67 (closes 926): Node counts `description.length` and `script.length` in UTF-16 units, so text outside the BMP
/// counts twice. 300 astral characters are 600 units: over the 500-unit description cap although 300 chars are not.
#[test]
fn the_description_cap_counts_utf16_units() {
    let meta = turn("😀".repeat(300), String::new()).workflow_launch_meta();
    let description = meta["description"].as_str().expect("a description");
    // `slice(0, 499)` keeps 249 whole characters and half of the 250th; the half cannot be held in a Rust string.
    assert_eq!(description, format!("{}…", "😀".repeat(249)));
    // 250 astral characters are exactly 500 units: at the cap, so kept whole.
    let meta = turn("😀".repeat(250), String::new()).workflow_launch_meta();
    assert_eq!(meta["description"], Value::from("😀".repeat(250)));
}

/// 130 000 astral characters are 260 000 units: over the 256 000-unit script cap, so the script is left out.
#[test]
fn the_script_cap_counts_utf16_units() {
    let long = turn(String::new(), "😀".repeat(130_000)).workflow_launch_meta();
    assert!(long.get("script").is_none());
    let fits = turn(String::new(), "😀".repeat(128_000)).workflow_launch_meta();
    assert_eq!(fits["script"].as_str().map(str::len), Some(512_000));
}
