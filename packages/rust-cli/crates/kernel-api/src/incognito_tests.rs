use serde_json::json;

use super::*;

/// Node's `JSON.stringify` of a profile with every capability but `mcp` and `hooks` off.
const NODE_STORED: &str = r#"{"projectInstructions":false,"skills":false,"hooks":true,"plugins":false,"mcp":true,"customAgents":false,"memory":false,"outputStyle":false,"systemPromptOverrides":false,"identity":false,"harness":false,"environment":false,"automationTools":false}"#;

fn mcp_and_hooks() -> IncognitoProfile {
    IncognitoProfile {
        hooks: true,
        mcp: true,
        ..IncognitoProfile::LOCKDOWN
    }
}

#[test]
fn a_node_stored_profile_reads_back_and_writes_the_same_bytes() {
    let profile = IncognitoProfile::from_stored(NODE_STORED);
    assert_eq!(profile, mcp_and_hooks());
    assert_eq!(profile.to_stored(), NODE_STORED);
}

#[test]
fn a_stored_value_this_build_cannot_parse_reads_as_lockdown() {
    let missing = NODE_STORED.replace(r#","automationTools":false"#, "");
    let unknown = NODE_STORED.replace('}', r#","extra":true}"#);
    let versioned = NODE_STORED.replace('}', r#","version":1}"#);
    for text in [
        "{",
        "null",
        "[]",
        missing.as_str(),
        unknown.as_str(),
        versioned.as_str(),
    ] {
        assert_eq!(
            IncognitoProfile::from_stored(text),
            IncognitoProfile::LOCKDOWN,
            "{text}"
        );
    }
}

#[test]
fn the_wire_profile_is_strict() {
    let value: serde_json::Value = serde_json::from_str(NODE_STORED).unwrap();
    assert_eq!(IncognitoProfile::from_wire(&value), Ok(mcp_and_hooks()));
    let mut extra = value.clone();
    extra["version"] = json!(1);
    assert!(IncognitoProfile::from_wire(&extra).is_err());
    let mut missing = value.clone();
    missing.as_object_mut().unwrap().remove("skills");
    assert!(IncognitoProfile::from_wire(&missing).is_err());
    let mut wrong = value;
    wrong["mcp"] = json!("yes");
    assert!(IncognitoProfile::from_wire(&wrong).is_err());
}

#[test]
fn excludes_only_an_incognito_session_without_the_key() {
    assert!(!excludes(None, IncognitoKey::Mcp));
    assert!(!excludes(Some(&mcp_and_hooks()), IncognitoKey::Mcp));
    assert!(excludes(Some(&mcp_and_hooks()), IncognitoKey::Skills));
    let profiles = IncognitoProfiles::default();
    let session = SessionId::new("s1");
    profiles.record(&session, None);
    assert_eq!(profiles.get(&session), None);
    profiles.record(&session, Some(mcp_and_hooks()));
    assert!(profiles.excludes(&session, IncognitoKey::Memory));
    assert!(!profiles.excludes(&SessionId::new("s2"), IncognitoKey::Memory));
}
