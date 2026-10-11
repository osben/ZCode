/**
 * Session file change tracker.
 *
 * Record before/after content for file writes made by the agent runtime.
 * If a file is modified several times in one turn, keep only the first before and the last after (merge the endpoints).
 *
 * Uses:
 * - Rewind: restore beforeContent in reverse order when rolling back to a turn.
 * - Aggregation: get the final result of all file operations in a session.
 */

// ---- Type definitions ----

/** A file's change snapshot for one turn (first before, last after). */
interface FileSnapshot {
  path: string;
  /** File content before its first modification in the turn; null means a new file. */
  beforeContent: string | null;
  /** Content from the last write in the turn. */
  afterContent: string;
  /** Number of writes during the turn. */
  writeCount: number;
}

/** File changes from one conversation turn. */
interface TurnFileChanges {
  turnIndex: number;
  /** File snapshots involved in the turn, keyed by path. */
  snapshots: Map<string, FileSnapshot>;
  /** Whether this turn's file changes are currently applied to the workspace. */
  fileState: "applied" | "reverted";
}

/** Serializable file snapshot for persistence. */
interface SerializedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
}

/** Serializable per-turn file changes for persistence. */
interface SerializedTurnFileChanges {
  turnIndex: number;
  snapshots: SerializedFileSnapshot[];
  fileState?: "applied" | "reverted";
}

// ---- Tracker ----

export class SessionFileChangeTracker {
  private turns: TurnFileChanges[] = [];
  private currentTurnIndex = -1;

  /** Start a new conversation turn and advance turnIndex. */
  newTurn(): number {
    this.currentTurnIndex++;
    this.turns.push({
      turnIndex: this.currentTurnIndex,
      snapshots: new Map(),
      fileState: "applied",
    });
    return this.currentTurnIndex;
  }

  /**
   * Record a file write operation.
   * Read the original content before calling writeTextFile, then call this method after the write.
   *
   * @param path File path.
   * @param beforeContent File content before the write; null means a new file.
   * @param afterContent File content after the write.
   */
  record(path: string, beforeContent: string | null, afterContent: string): void {
    if (this.currentTurnIndex < 0) {
      // Create the first turn automatically if newTurn has not been called yet.
      this.newTurn();
    }

    const currentTurn = this.turns[this.turns.length - 1]!;
    const existing = currentTurn.snapshots.get(path);

    if (existing) {
      // For the same file in the same turn, keep the first before and update after.
      existing.afterContent = afterContent;
      existing.writeCount++;
    } else {
      currentTurn.snapshots.set(path, {
        path,
        beforeContent,
        afterContent,
        writeCount: 1,
      });
    }
  }

  /** Get file changes for the specified turn. */
  getChangesForTurn(turnIndex: number): FileSnapshot[] {
    const turn = this.turns.find((t) => t.turnIndex === turnIndex);
    if (!turn) return [];
    return Array.from(turn.snapshots.values());
  }

  /** Get file status for the specified turn. */
  getFileStateForTurn(turnIndex: number): "applied" | "reverted" {
    return this.turns.find((turn) => turn.turnIndex === turnIndex)?.fileState ?? "applied";
  }

  /** Update file status for the specified turn. */
  setFileStateForTurn(turnIndex: number, fileState: "applied" | "reverted"): void {
    const turn = this.turns.find((item) => item.turnIndex === turnIndex);
    if (!turn) {
      return;
    }
    turn.fileState = fileState;
  }

  /** Get all file changes after (excluding) the specified turn, in turn order. */
  getChangesAfterTurn(turnIndex: number): FileSnapshot[] {
    const result: FileSnapshot[] = [];
    for (const turn of this.turns) {
      if (turn.turnIndex > turnIndex) {
        result.push(...turn.snapshots.values());
      }
    }
    return result;
  }

  /**
   * Calculate the file restoration operations required to roll back to the specified turn.
   * Return the content each file should be restored to (null means the file should be deleted).
   * Collect the earliest beforeContent for each file across turns after toTurnIndex.
   * If a file was also changed in or before toTurnIndex, use its afterContent from that turn.
   */
  getRewindOperations(toTurnIndex: number): Map<string, string | null> {
    const rewindOps = new Map<string, string | null>();

    // Iterate backward from the latest turn to (excluding) toTurnIndex, overwriting each file;
    // the remaining value is the earliest beforeContent for that file in the rollback range.
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]!;
      if (turn.turnIndex <= toTurnIndex) break;

      for (const snapshot of turn.snapshots.values()) {
        rewindOps.set(snapshot.path, snapshot.beforeContent);
      }
    }

    // If the file was also changed in or before toTurnIndex, use its afterContent from that turn.
    for (const turn of this.turns) {
      if (turn.turnIndex > toTurnIndex) break;
      for (const snapshot of turn.snapshots.values()) {
        if (rewindOps.has(snapshot.path)) {
          rewindOps.set(snapshot.path, snapshot.afterContent);
        }
      }
    }

    return rewindOps;
  }

  /** Get every modified file in the session and its final content. */
  getAllChangedFiles(): Map<string, { originalContent: string | null; finalContent: string }> {
    const result = new Map<string, { originalContent: string | null; finalContent: string }>();

    for (const turn of this.turns) {
      for (const snapshot of turn.snapshots.values()) {
        const existing = result.get(snapshot.path);
        if (existing) {
          // Update finalContent while preserving originalContent.
          existing.finalContent = snapshot.afterContent;
        } else {
          result.set(snapshot.path, {
            originalContent: snapshot.beforeContent,
            finalContent: snapshot.afterContent,
          });
        }
      }
    }

    return result;
  }

  /** Get the current turn index. */
  getCurrentTurnIndex(): number {
    return this.currentTurnIndex;
  }

  /** Restore the current turn cursor for legacy tasks that have message history but no fileChanges. */
  restoreCurrentTurnIndex(turnIndex: number): void {
    if (!Number.isFinite(turnIndex)) {
      return;
    }

    // Bugfix: imported history often has messages.turnIndex but no fileChanges.
    // If restoration does not advance the cursor to the last turn, the next sendPrompt starts numbering from 0,
    // placing follow-up messages in the same turn as the imported history and skewing fork/retry boundary checks.
    this.currentTurnIndex = Math.max(this.currentTurnIndex, Math.trunc(turnIndex));
  }

  /** Get the total number of turns. */
  getTurnCount(): number {
    return this.turns.length;
  }

  // ---- Serialization/deserialization for persistence ----

  /** Serialize to a JSON-compatible structure. */
  serialize(): SerializedTurnFileChanges[] {
    return this.turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      snapshots: Array.from(turn.snapshots.values()),
      fileState: turn.fileState,
    }));
  }

  /** Restore from serialized data. */
  static deserialize(data: SerializedTurnFileChanges[]): SessionFileChangeTracker {
    const tracker = new SessionFileChangeTracker();
    for (const turn of data) {
      const snapshots = new Map<string, FileSnapshot>();
      for (const s of turn.snapshots) {
        snapshots.set(s.path, { ...s });
      }
      tracker.turns.push({
        turnIndex: turn.turnIndex,
        snapshots,
        fileState: turn.fileState ?? "applied",
      });
    }
    tracker.currentTurnIndex = data.length > 0 ? data[data.length - 1]!.turnIndex : -1;
    return tracker;
  }

  /** Truncate at the specified turn (inclusive) and delete all later records. */
  truncateAfterTurn(turnIndex: number): void {
    this.turns = this.turns.filter((t) => t.turnIndex <= turnIndex);
    this.currentTurnIndex =
      this.turns.length > 0 ? this.turns[this.turns.length - 1]!.turnIndex : -1;
  }
}
