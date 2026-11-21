//! Fork: the typecheck of a dynamic-workflow script (Node `analyzeScript` in `core/src/tool/handlers/workflow-script-analysis.ts`,
//! specs/fork-rust-workflow-engine.md, W7-8b). SaveWorkflow compiles the script with the same checker as CreateWorkflow
//! before it asks or writes. The checker runs on the helper (`helper/workflow/format`, kind `analysis`), so the tools
//! reach it through this port; `protocol-zcode` implements it over the helper link.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// One diagnostic of the checker, positioned in the script (1-based), as Node's `CreateWorkflowDiagnostic`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowDiagnostic {
    pub code: i64,
    pub line: i64,
    pub column: i64,
    pub message: String,
}

/// Fork (9.63): one model name a persona of the script names (Node `ModelReference`): the name verbatim, at its site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelReference {
    pub name: String,
    pub line: i64,
    pub column: i64,
}

/// The checker's verdict for one script: `ok` is true when no error diagnostic was found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowAnalysis {
    pub ok: bool,
    pub diagnostics: Vec<WorkflowDiagnostic>,
    /// Fork (9.63): the model names the personas name, in discovery order (Node `modelReferences`).
    #[serde(default, rename = "modelReferences")]
    pub model_references: Vec<ModelReference>,
}

/// The checker could not answer (the helper is not running or its reply does not match its contract). Nothing is
/// decided on a failed check, so the caller reports it and writes nothing.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct WorkflowAnalysisError {
    pub message: String,
}

/// Analyzes one workflow script. Implemented over the helper link by `protocol-zcode`.
#[async_trait]
pub trait WorkflowAnalyzer: Send + Sync {
    async fn analyze(&self, script: &str) -> Result<WorkflowAnalysis, WorkflowAnalysisError>;

    /// The `create_workflow` display of a script that checks (Node `displayOfAnalysis`: the causality graph the
    /// confirmation window and the result card draw). `None` when the checker has no display for it.
    ///
    /// Fork (9.63, closes 906): `model_bindings` is the script's model table; Node opens a window for a script that
    /// names models only with every name bound.
    async fn display(
        &self,
        _script: &str,
        _model_bindings: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> Result<Option<serde_json::Value>, WorkflowAnalysisError> {
        Ok(None)
    }
}
