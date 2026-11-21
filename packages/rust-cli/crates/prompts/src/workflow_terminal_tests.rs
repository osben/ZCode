//! W8d: the terminal notice of a dynamic workflow run (Node `formatLocalWorkflowTaskNotification`, `buildWorkflowTaskSummary`,
//! `workflowDeliveryGuidance`). The texts are Node's, byte for byte, for the branches this port builds.

use super::*;

fn run<'a>(status: &'a str) -> Terminal<'a> {
    Terminal {
        run_id: "dwfrun-1",
        subject: "Audit",
        tool_use_id: None,
        status,
        stop_reason: None,
        result: None,
        error: None,
        auto_resumes_after_reset: false,
    }
}

#[test]
fn a_completed_run_names_its_result_and_asks_for_a_deliverable() {
    let text = terminal(&Terminal {
        result: Some(r#"{"n":2}"#),
        ..run("completed")
    });
    let expected = concat!(
        "<task-notification>\n",
        "<task-id>dwfrun-1</task-id>\n",
        "<status>completed</status>\n",
        "<description>Audit</description>\n",
        "<summary>Workflow &quot;Audit&quot; completed.</summary>\n",
        "<result>{&quot;n&quot;:2}</result>\n",
        "</task-notification>\n",
        "\n",
        "The workflow completed. Present its outcome to the user as a deliverable, in this order: the conclusion; each finding with its evidence (path and line, or the command and output that showed it); which findings were confirmed by a deterministic check or an independent subagent and which are judged only; what the run did not cover.\n",
        "The reported items above are individual findings: present them individually and keep their evidence. When the preview is partial (count greater than shown), say so and read the rest with GetWorkflowRun.\n",
        "Do not restate the phase graph or the script.",
    );
    assert_eq!(text, expected);
}

#[test]
fn a_run_stopped_by_the_user_says_so_and_does_not_resume_it() {
    let text = terminal(&Terminal {
        stop_reason: Some("user"),
        ..run("stopped")
    });
    let expected = concat!(
        "<task-notification>\n",
        "<task-id>dwfrun-1</task-id>\n",
        "<status>stopped</status>\n",
        "<stop-reason>user</stop-reason>\n",
        "<description>Audit</description>\n",
        "<summary>Workflow &quot;Audit&quot; was stopped by the user.</summary>\n",
        "</task-notification>\n",
        "\n",
        "The user stopped this workflow on purpose. Do not resume it with ResumeWorkflowRun and do not amend or rebuild it unless the user asks you to.\n",
        "Present what it finished before it was stopped: the reported items above are finished findings — show them individually with their evidence. Then stop and wait for the user to say what happens next.",
    );
    assert_eq!(text, expected);
}

#[test]
fn an_errored_run_carries_its_plain_error_escaped_and_points_to_amend() {
    let text = terminal(&Terminal {
        error: Some(ErrorText::Plain("boom <x> & \"y\"")),
        ..run("errored")
    });
    assert!(text.contains(
        "<summary>Workflow &quot;Audit&quot; errored: the script failed.</summary>\n<error>boom &lt;x&gt; &amp; &quot;y&quot;</error>\n</task-notification>"
    ));
    assert!(text.ends_with(
        "Fix the script and submit it with AmendWorkflow (run_id=\"dwfrun-1\") so finished work is reused. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way."
    ));
}

#[test]
fn a_provider_stop_error_is_a_block_escaped_for_angle_brackets_and_amp_only() {
    let text = terminal(&Terminal {
        stop_reason: Some("provider"),
        error: Some(ErrorText::ProviderStop("Use \"x\" <here> & go")),
        ..run("stopped")
    });
    assert!(
        text.contains("<error>\nUse \"x\" &lt;here&gt; &amp; go\n</error>\n</task-notification>")
    );
    assert!(text.contains(
        "Then resolve the cause with the user before calling ResumeWorkflowRun with run_id=\"dwfrun-1\" — finished steps replay from the journal. Do not rebuild the workflow."
    ));
}

#[test]
fn a_quota_stop_that_resumes_by_itself_says_so_and_does_not_resume() {
    let text = terminal(&Terminal {
        stop_reason: Some("provider"),
        auto_resumes_after_reset: true,
        ..run("stopped")
    });
    assert!(text.contains(
        "The run resumes by itself after the usage cap resets (the <error> block says when): tell the user, and do not call ResumeWorkflowRun or rebuild the workflow before then."
    ));
}

#[test]
fn a_model_stop_points_to_amend_and_an_interrupted_run_to_resume() {
    let model = terminal(&Terminal {
        stop_reason: Some("model"),
        ..run("stopped")
    });
    assert!(
        model.contains(
            "<summary>Workflow &quot;Audit&quot; was stopped by you (TaskStop).</summary>"
        )
    );
    assert!(model.contains("call AmendWorkflow with this run's ID and the corrected script"));

    let interrupted = terminal(&Terminal {
        stop_reason: Some("interrupted"),
        ..run("stopped")
    });
    assert!(interrupted.contains(
        "<summary>Workflow &quot;Audit&quot; was stopped: the process that owned it exited.</summary>"
    ));
    assert!(interrupted.contains(
        "Then call ResumeWorkflowRun with run_id=\"dwfrun-1\" — finished steps replay from the journal and only the unfinished ones run again."
    ));
}

#[test]
fn a_superseded_stop_says_a_newer_run_runs_and_never_says_resume() {
    let text = terminal(&Terminal {
        stop_reason: Some("superseded"),
        ..run("stopped")
    });
    assert!(text.contains("was stopped and superseded by an amended run."));
    assert!(!text.contains("ResumeWorkflowRun with"));
}

#[test]
fn the_summary_is_one_sentence_per_terminal_state() {
    assert_eq!(summary("A", "completed", None), "Workflow \"A\" completed.");
    assert_eq!(
        summary("A", "errored", None),
        "Workflow \"A\" errored: the script failed."
    );
    assert_eq!(summary("A", "stopped", None), "Workflow \"A\" was stopped.");
    assert_eq!(
        summary("A", "stopped", Some("provider")),
        "Workflow \"A\" was stopped on a provider error."
    );
}

#[test]
fn the_tool_use_id_is_written_after_the_task_id_when_the_run_has_one() {
    let text = terminal(&Terminal {
        tool_use_id: Some("toolu_9"),
        ..run("completed")
    });
    assert!(text.starts_with(
        "<task-notification>\n<task-id>dwfrun-1</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>completed</status>"
    ));
}

#[test]
fn a_stop_reason_is_only_read_from_a_stopped_run() {
    // A completed or errored run with a residual stop reason says what its status says, as Node does (workflowSnapshotTerminal).
    let completed = terminal(&Terminal {
        stop_reason: Some("user"),
        ..run("completed")
    });
    assert!(!completed.contains("<stop-reason>"));
    assert!(completed.contains("The workflow completed."));
    let errored = terminal(&Terminal {
        stop_reason: Some("provider"),
        ..run("errored")
    });
    assert!(!errored.contains("<stop-reason>"));
    assert!(errored.contains("Fix the script and submit it with AmendWorkflow"));
}

#[test]
fn an_unknown_status_is_a_failure_and_never_a_completion() {
    assert_eq!(summary("A", "killed", None), "Workflow \"A\" failed.");
}
