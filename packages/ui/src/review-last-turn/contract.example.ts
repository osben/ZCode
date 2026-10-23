// Example wiring (documentation only, not compiled into the app).
// The side pane renders the wrapper in place of GitPane; the wrapper owns no Git state of its own.
import { createElement } from "react";
import type { ComponentProps } from "react";
import { GitPaneWithLastTurn } from "@/review-last-turn/index.js";

export function exampleReviewPane(props: ComponentProps<typeof GitPaneWithLastTurn>) {
  return createElement(GitPaneWithLastTurn, props);
}
