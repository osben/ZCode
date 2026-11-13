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
