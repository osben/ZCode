use super::*;

#[test]
fn families_round_trip_their_node_names() {
    for family in [Family::Zai, Family::Bigmodel] {
        assert_eq!(Family::parse(family.as_str()), Some(family));
    }
    assert_eq!(Family::parse("Zai"), None);
    assert_eq!(Family::Bigmodel.display_name(), "BigModel");
}

#[test]
fn chatgpt_plan_ids_round_trip_like_node() {
    let key = "0123456789abcdef";
    assert!(is_chatgpt_plan_account_key(key));
    assert!(is_chatgpt_plan_account_key(" 0123456789abcdef "));
    assert!(!is_chatgpt_plan_account_key("0123456789ABCDEF"));
    assert!(!is_chatgpt_plan_account_key("0123456789abcde"));
    let provider = chatgpt_plan_account_provider(key);
    assert_eq!(provider, "account:chatgpt-plan:0123456789abcdef");
    assert_eq!(chatgpt_plan_account(&provider), Some(key));
    // The key comes back canonical (trimmed), so credential slots built from it match.
    assert_eq!(
        chatgpt_plan_account("account:chatgpt-plan: 0123456789abcdef "),
        Some(key)
    );
    assert_eq!(chatgpt_plan_account(CHATGPT_PLAN_PROVIDER), None);
    assert_eq!(chatgpt_plan_account("account:chatgpt-plan:xyz"), None);
    assert_eq!(
        chatgpt_plan_account("account:chatgpt-planx:0123456789abcdef"),
        None
    );
    assert_eq!(
        chatgpt_plan_account("account:zai-individual-coding-plan"),
        None
    );
}
