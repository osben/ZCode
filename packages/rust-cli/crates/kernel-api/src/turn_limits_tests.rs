use super::*;

#[test]
fn an_ordinary_turn_hides_only_cron_pause_self() {
    let limits = TurnLimits::default();
    assert!(limits.is_empty());
    assert!(limits.hides("CronPauseSelf"));
    for name in ["CronCreate", "CronUpdate", "CronDelete", "CronList", "Bash"] {
        assert!(!limits.hides(name), "{name}");
    }
}

#[test]
fn an_automation_turn_hides_the_mutation_tools_and_offers_pause_self() {
    let limits = TurnLimits::new(Some(" auto-1 "), Vec::new());
    assert_eq!(limits.automation(), Some("auto-1"));
    for name in ["CronCreate", "CronUpdate", "CronDelete"] {
        assert!(limits.hides(name), "{name}");
    }
    assert!(!limits.hides("CronList"));
    assert!(!limits.hides("CronPauseSelf"));
    assert!(
        !limits.hides("OffPeakCreate"),
        "a cron run may schedule off-peak work"
    );
}

#[test]
fn a_blank_automation_id_is_none() {
    let limits = TurnLimits::new(Some("  "), Vec::new());
    assert!(limits.automation().is_none());
    assert!(limits.hides("CronPauseSelf"));
}

/// A decoded value keeps the trimmed, non-empty rule: a blank id is no automation, so an ordinary turn never becomes a
/// pseudo-automation turn.
#[test]
fn a_decoded_blank_automation_id_is_none() {
    for raw in ["", "   "] {
        let limits: TurnLimits =
            serde_json::from_value(serde_json::json!({"automation": raw})).unwrap();
        assert!(limits.automation().is_none(), "{raw:?}");
        assert!(limits.is_empty());
        assert!(limits.hides("CronPauseSelf"));
        assert!(!limits.hides("CronDelete"));
    }
    let limits: TurnLimits =
        serde_json::from_value(serde_json::json!({"automation": " a1 "})).unwrap();
    assert_eq!(limits.automation(), Some("a1"));
}

#[test]
fn the_disallowlist_hides_its_names() {
    let limits = TurnLimits::new(None, vec!["OffPeakCreate".to_owned(), "Bash".to_owned()]);
    assert!(!limits.is_empty());
    assert!(limits.hides("OffPeakCreate"));
    assert!(limits.hides("Bash"));
    assert!(!limits.hides("Read"));
}

#[test]
fn empty_limits_serialize_to_nothing() {
    assert_eq!(
        serde_json::to_value(TurnLimits::default()).unwrap(),
        serde_json::json!({})
    );
    let limits = TurnLimits::new(Some("a"), vec!["Bash".to_owned()]);
    let back: TurnLimits = serde_json::from_value(serde_json::to_value(&limits).unwrap()).unwrap();
    assert_eq!(back, limits);
}

#[test]
fn a_turn_is_restricted_by_its_automation_id_or_a_disallowlist_covering_all_three_mutations() {
    assert!(!TurnLimits::default().restricts_automation_mutations());
    assert!(TurnLimits::new(Some("auto-1"), Vec::new()).restricts_automation_mutations());
    let all = vec![
        "CronCreate".to_owned(),
        "CronUpdate".to_owned(),
        "CronDelete".to_owned(),
    ];
    assert!(TurnLimits::new(None, all).restricts_automation_mutations());
    let some = vec!["CronCreate".to_owned(), "CronDelete".to_owned()];
    assert!(!TurnLimits::new(None, some).restricts_automation_mutations());
}

/// Fork (slice 3 layer B): a decoded off-peak id is trimmed and a blank one is none, like the automation id; a decoded
/// model never outlives its run.
#[test]
fn a_decoded_off_peak_run_is_normalized_like_its_constructor() {
    for raw in ["", "   "] {
        let limits: TurnLimits =
            serde_json::from_value(serde_json::json!({"off_peak_execution": raw})).unwrap();
        assert!(limits.off_peak_execution().is_none(), "{raw:?}");
        assert!(limits.is_empty());
    }
    let limits: TurnLimits =
        serde_json::from_value(serde_json::json!({"off_peak_execution": " exe_1 "})).unwrap();
    assert_eq!(limits.off_peak_execution(), Some("exe_1"));
    let model = serde_json::json!({"provider": "zai", "model": "glm-idle"});
    let orphan: TurnLimits =
        serde_json::from_value(serde_json::json!({"off_peak_selection": model})).unwrap();
    assert!(
        orphan.off_peak_selection().is_none(),
        "a model without its run is dropped"
    );
    assert!(orphan.is_empty());
}

/// The constructor drops a blank run and its model with it.
#[test]
fn a_blank_off_peak_run_takes_its_model_with_it() {
    let model = rust_cli_kernel_api_model_selection();
    let blank = TurnLimits::default().with_off_peak_run(Some("  "), Some(model.clone()));
    assert!(blank.off_peak_selection().is_none());
    assert!(blank.is_empty());
    let run = TurnLimits::default().with_off_peak_run(Some(" exe_1 "), Some(model.clone()));
    assert_eq!(run.off_peak_selection(), Some(&model));
}

fn rust_cli_kernel_api_model_selection() -> crate::model::ModelSelection {
    crate::model::ModelSelection::new("zai", "glm-idle")
}
