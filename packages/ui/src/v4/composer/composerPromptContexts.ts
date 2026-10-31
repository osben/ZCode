import {
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";
import {
  buildPromptWithConversationSelections,
  parsePromptConversationSelections,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import {
  buildPromptWithPptxElementReferences,
  parsePromptPptxElementReferences,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";
import {
  buildPromptWithPluginUiContexts,
  parsePromptPluginUiContexts,
  type PluginUiModelContext,
} from "@/plugin-ui/index.js";

export interface ComposerPromptContexts {
  codeComments: readonly CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: readonly WebElementContextComposerAttachment[];
  pptxElements: readonly PptxElementReference[];
  /** Added by plugin UI through ui/update-model-context; treated as empty when absent. */
  pluginUiContexts?: readonly PluginUiModelContext[];
}

export function countComposerPromptContexts(contexts: {
  codeComments: readonly unknown[];
  conversationSelections: readonly unknown[];
  webElements: readonly unknown[];
  pptxElements: readonly unknown[];
  pluginUiContexts?: readonly unknown[];
}) {
  return (
    contexts.codeComments.length +
    contexts.conversationSelections.length +
    contexts.webElements.length +
    contexts.pptxElements.length +
    (contexts.pluginUiContexts?.length ?? 0)
  );
}

/** All four context parsers recognize only trailing prompt blocks, so serialization order must be exactly the reverse of parsing order. */
export function serializeComposerPromptContexts(
  text: string,
  contexts: ComposerPromptContexts,
): string {
  const withSelections = buildPromptWithConversationSelections(
    text,
    contexts.conversationSelections,
  );
  const withCodeComments = buildPromptWithCodeComments(withSelections, contexts.codeComments);
  const withWebElements = buildPromptWithWebElementContexts(withCodeComments, contexts.webElements);
  const withPptx = buildPromptWithPptxElementReferences(withWebElements, contexts.pptxElements);
  return buildPromptWithPluginUiContexts(withPptx, contexts.pluginUiContexts ?? []);
}

export function parseComposerPromptContexts(
  content: string,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): {
  visibleContent: string;
  codeComments: CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: WebElementContextComposerAttachment[];
  pptxElements: PptxElementReference[];
  pluginUiContexts: PluginUiModelContext[];
} {
  const plugin = parsePromptPluginUiContexts(content);
  const pptx = parsePromptPptxElementReferences(plugin.visibleContent);
  const web = parsePromptWebElementContexts(pptx.visibleContent, workspace);
  const code = parsePromptCodeComments(web.visibleContent, workspace);
  const selections = parsePromptConversationSelections(code.visibleContent);
  return {
    visibleContent: selections.visibleContent,
    codeComments: code.codeCommentAttachments,
    conversationSelections: selections.references,
    webElements: web.webElementContexts,
    pptxElements: pptx.pptxElementReferences,
    pluginUiContexts: plugin.pluginUiContexts,
  };
}
