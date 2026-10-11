import type { ModelSelection } from "@zcode/shared";
import type { IModelSelectionService } from "@zcode/services";

/** Fix the model identity at the boundary where an Automation Select becomes a Submission. */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // A fixed run is an execution fact; retries must not remap it to another account or change it because of a current read failure.
  if (params.fixedSelection) return params.fixedSelection;
  // The Scheduler snapshot may predate the Host's one-way import; first execution uses the updated intent after persistence validation.
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    }
    return view.effectiveSelection;
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation 无法从目标 Host 解析首选模型");
  }
  return preferredSelection;
}
