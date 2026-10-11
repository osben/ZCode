export interface TaskFindNavigationState {
  activeIndex: number;
  navigationRequestId: number;
  query: string;
}

export function createTaskFindNavigationState(): TaskFindNavigationState {
  return {
    activeIndex: -1,
    navigationRequestId: 0,
    query: "",
  };
}

export function changeTaskFindSelection(
  state: TaskFindNavigationState,
  query: string,
  activeIndex: number,
): TaskFindNavigationState {
  return {
    activeIndex,
    navigationRequestId: state.navigationRequestId,
    query,
  };
}

export function navigateTaskFindSelection(
  state: TaskFindNavigationState,
  query: string,
  activeIndex: number,
): TaskFindNavigationState {
  // When wrapping around a single match, query/index do not change; navigation identity must increment independently in the state owner.
  // Update all three pieces of state in one transition so later maintenance cannot split them across App setters.
  return {
    activeIndex,
    navigationRequestId: state.navigationRequestId + 1,
    query,
  };
}
