//! 子代理的模型选择（工作线 F49）：团队项目跟父运行。

use rust_cli_base::models::{GLM_5_3_ACCOUNT, GLM_5_3_FLASH_ACCOUNT};
use rust_cli_kernel_api::model::{ModelConnection, ModelSelection};

use super::{Ending, Finished, QueryError, Report, selection};

#[test]
fn a_child_keeps_the_team_project_of_the_parent() {
    let parent = ModelSelection {
        reasoning: Some("high".to_owned()),
        connection: Some(Box::new(ModelConnection {
            product_id: "prod-1".to_owned(),
            organization_id: "org-t".to_owned(),
            project_id: "p-t".to_owned(),
        })),
        ..ModelSelection::new(
            "account:bigmodel-team-coding-plan".to_owned(),
            GLM_5_3_ACCOUNT.to_owned(),
        )
    };
    assert_eq!(selection(&parent, Some("inherit"), None), parent);
    let child = selection(&parent, Some(GLM_5_3_FLASH_ACCOUNT), Some("low".to_owned()));
    assert_eq!(child.model, GLM_5_3_FLASH_ACCOUNT);
    assert_eq!(child.reasoning.as_deref(), Some("low"));
    assert_eq!(child.connection, parent.connection);
}

/// Fork (node_desktop): a failed subagent reports the provider's own rate limit or overload message like Node; the
/// TUI keeps the typed error text, and other errors read the same on both.
#[test]
fn the_desktop_failure_reason_is_the_provider_message() {
    use rust_cli_kernel_api::model::ModelError;
    let finished = |error: ModelError| Finished {
        ending: Ending::Failed,
        report: Report {
            text: String::new(),
            tokens: 0,
            tool_uses: 0,
            duration_ms: 0,
        },
        error: Some(QueryError::Model(error)),
    };
    let limited = finished(ModelError::RateLimited {
        message: "Requests are too frequent. Request id: r1".to_owned(),
        retry_after_ms: None,
    });
    assert_eq!(
        limited.failure(true).as_deref(),
        Some("Requests are too frequent. Request id: r1")
    );
    assert_eq!(
        limited.failure(false).as_deref(),
        Some("rate limited: Requests are too frequent. Request id: r1")
    );
    let overloaded = finished(ModelError::Overloaded {
        message: "busy".to_owned(),
    });
    assert_eq!(overloaded.failure(true).as_deref(), Some("busy"));
    let server = finished(ModelError::Server {
        status: 500,
        message: "boom".to_owned(),
    });
    assert_eq!(
        server.failure(true).as_deref(),
        Some("server error 500: boom")
    );
    let none = Finished {
        error: None,
        ..finished(ModelError::Cancelled)
    };
    assert_eq!(none.failure(true), None);
}
