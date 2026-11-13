//! Models 的子页（providers.rs）：provider 的页、新 provider、模型页与测试连接，照 Puffin 的页；改动两边的 host 都还没
//! 有，说的是 Puffin 的 host 回答之后的那句话（tui-kit.md §4.5）。
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::selection;

use super::super::data::{self, Section, SectionData};
use super::super::page::{Change, Page, ProviderEdit, Row};
use super::super::{Request, Settings};
use crate::services::FamilyModel;
use crate::ui::app::Action;
use crate::ui::app::App;
use crate::ui::i18n::Lang;
use crate::ui::probe::{ColorLevel, Colors};
use crate::view::Transcript;

fn models() -> data::Models {
    data::Models {
        providers: vec![data::Provider {
            id: "acme".into(),
            name: "Acme".into(),
            models: vec![FamilyModel {
                id: "acme-1".into(),
                enabled: true,
                context_window: Some(128_000),
            }],
        }],
        ..data::Models::default()
    }
}

/// 设置页开在 `page` 上，Models 已读到。
fn app_on(page: Option<Page>) -> App {
    let mut app = App::new(
        Colors::new(ColorLevel::TrueColor, Some((0, 0, 0))),
        Lang::En,
        Transcript::new(
            selection(),
            PermissionMode::Default,
            crate::view::test_workspace(),
        ),
        Some("/Users/dev".into()),
        "0.1.0".into(),
    );
    let mut ui = Settings {
        section: rust_cli_tui_kit::app::widgets::settings::section_index("models").unwrap_or(0),
        in_list: false,
        ..Settings::default()
    };
    ui.data
        .insert(Section::Models, SectionData::Models(models()));
    ui.stack.extend(page);
    app.settings = Some(ui);
    app
}

fn ids(app: &App) -> Vec<String> {
    let ui = app.settings.clone().expect("settings open");
    app.settings_view(&ui, 0).rows.iter().map(Row::id).collect()
}

fn press(app: &mut App, code: KeyCode) {
    let _ = app.settings_key(KeyEvent::new(code, KeyModifiers::NONE));
}

/// 选中 id 为 `id` 的行。
fn choose(app: &mut App, id: &str) {
    let ui = app.settings.as_mut().expect("settings open");
    ui.chosen.insert(ui.page(), id.to_owned());
}

fn said(app: &App) -> Option<Result<String, String>> {
    app.settings.as_ref().and_then(|ui| ui.said.clone())
}

/// 两边的 host 的回答（cli 的 Puffin host 与 runner 的 `UNAVAILABLE`）。
const UNAVAILABLE: &str = "This isn't available in this version yet";

/// 在选中的行上按 `code`：交给 runner 写的改动，与 host 回答这一版还没有之后说的。
fn refused(app: &mut App, code: KeyCode) -> (Change, Option<Result<String, String>>) {
    let asked = app.settings_key(KeyEvent::new(code, KeyModifiers::NONE));
    let Some(Action::Settings(Request::Write { page, key, write })) = asked else {
        panic!("expected a write, got {asked:?}");
    };
    // 回答来之前什么也不说（Puffin 的写也要等 host）。
    assert_eq!(said(app), None);
    let _ = app.settings_wrote(&page, &key, &write, Err(UNAVAILABLE.into()));
    (write.change, said(app))
}

fn unsaved() -> Option<Result<String, String>> {
    Some(Err(format!("Could not save: {UNAVAILABLE}")))
}

#[test]
fn the_models_list_opens_a_provider_and_the_new_provider_page() {
    let mut app = app_on(None);
    choose(&mut app, "provider:acme");
    press(&mut app, KeyCode::Enter);
    assert_eq!(
        app.settings.as_ref().map(Settings::page),
        Some(Page::Provider("acme".into()))
    );
    assert_eq!(
        ids(&app),
        [
            "name",
            "format",
            "baseUrl",
            "apiKey",
            "enabled",
            "heading:Models",
            "model:acme:acme-1",
            "deleteProvider"
        ]
    );
    press(&mut app, KeyCode::Esc);
    choose(&mut app, "addProvider");
    press(&mut app, KeyCode::Enter);
    assert_eq!(ids(&app), ["custom"]);
    press(&mut app, KeyCode::Enter);
    assert_eq!(
        app.settings.as_ref().map(Settings::page),
        Some(Page::ProviderForm)
    );
    assert_eq!(ids(&app), ["np.name", "np.add"]);
}

#[test]
fn changes_neither_host_has_go_to_the_runner_and_say_what_puffin_says() {
    // 开关 provider 与它的 Enabled：经 runner 写，两边的 host 都回答这一版还没有。
    let mut app = app_on(None);
    choose(&mut app, "provider:acme");
    let (change, said_then) = refused(&mut app, KeyCode::Char(' '));
    assert_eq!(
        change,
        Change::Provider {
            provider: "acme".into(),
            edit: ProviderEdit::Enabled(false)
        }
    );
    assert_eq!(said_then, unsaved());
    let mut app = app_on(Some(Page::Provider("acme".into())));
    choose(&mut app, "enabled");
    assert_eq!(refused(&mut app, KeyCode::Char(' ')).1, unsaved());
    // 添加：没有名字当场先要名字；有了交给 runner，回答之后说加不了。
    let mut app = app_on(Some(Page::ProviderForm));
    choose(&mut app, "np.add");
    press(&mut app, KeyCode::Enter);
    assert_eq!(said(&app), Some(Err("Give it a name first.".into())));
    if let Some(ui) = app.settings.as_mut() {
        ui.form.insert("np.name".into(), " Mine ".into());
        ui.said = None;
    }
    let (change, said_then) = refused(&mut app, KeyCode::Enter);
    assert_eq!(
        change,
        Change::NewProvider {
            name: "Mine".into()
        }
    );
    assert_eq!(
        said_then,
        Some(Err(format!("Could not add it: {UNAVAILABLE}")))
    );
}

#[test]
fn the_model_page_tests_through_the_runner_and_a_late_answer_is_dropped() {
    let mut app = app_on(Some(Page::Provider("acme".into())));
    choose(&mut app, "model:acme:acme-1");
    press(&mut app, KeyCode::Enter);
    assert_eq!(ids(&app), ["info:Model ID", "info:Context window", "test"]);
    choose(&mut app, "test");
    // 同 Puffin：先画在测的样子，问 runner；回答回来之前没有结果。
    let asked = app.settings_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_eq!(
        asked,
        Some(Action::Settings(Request::Test {
            key: "test".into(),
            provider: "acme".into(),
            model: "acme-1".into(),
        }))
    );
    let test = |app: &App| app.settings.as_ref().and_then(|ui| ui.test.clone());
    assert_eq!(test(&app), Some(("test".into(), None)));
    app.settings_tested("test", Err(UNAVAILABLE.into()));
    assert_eq!(
        test(&app),
        Some(("test".into(), Some(Err(UNAVAILABLE.into()))))
    );
    // 退了页之后回来的回答不算。
    press(&mut app, KeyCode::Esc);
    assert_eq!(test(&app), None);
    app.settings_tested("test", Err(UNAVAILABLE.into()));
    assert_eq!(test(&app), None);
}

/// B7 (fork spec `fork-rust-credential-cipher.md` F2): a family whose saved sign-in cannot be read offers neither
/// Sign in nor Sign out; its Account row says so.
#[test]
fn an_unreadable_family_page_offers_neither_sign_in_nor_sign_out() {
    let mut app = app_on(Some(Page::Family("zai".into())));
    if let Some(ui) = app.settings.as_mut() {
        ui.data.insert(
            Section::Models,
            SectionData::Models(data::Models {
                families: vec![crate::services::FamilyStatus {
                    family: crate::services::Family::Zai,
                    name: "Z.ai".into(),
                    login: crate::services::FamilyLogin::Unreadable,
                    account: String::new(),
                    connection: crate::services::PlanConnection::Individual,
                    teams: Vec::new(),
                    teams_error: String::new(),
                    provider: "zai".into(),
                    models: Vec::new(),
                }],
                ..models()
            }),
        );
    }
    let rows = ids(&app);
    assert!(rows.contains(&"info:Account".to_owned()), "{rows:?}");
    assert!(
        !rows.iter().any(|r| r == "signIn" || r == "signOut"),
        "{rows:?}"
    );
    let ui = app.settings.clone().expect("settings open");
    let view = app.settings_view(&ui, 0);
    let account = view.rows.iter().find_map(|row| match row {
        Row::Info { label, value } if label == "Account" => {
            Some(value.iter().map(|p| p.text.as_str()).collect::<String>())
        }
        _ => None,
    });
    assert_eq!(account.as_deref(), Some("Could not read the saved sign-in"));
    assert!(
        view.rows.iter().any(
            |row| matches!(row, Row::Note(note) if note == "Could not read the saved sign-in.")
        ),
        "the models note says the sign-in could not be read"
    );
}
