import type { Event } from "@zcode/rpc";
import type {
  RemoteTarget,
  SourceServerUpdateRequest,
  SourceServerMigrationReport,
  SourceServerManagementSnapshot,
  SourceServerManagementSnapshotRequest,
  SourceServerManagementDirectoryDelta,
  SourceServerManagementStateDelta,
  SourceServerOperationLog,
  SourceServerRunningTasksResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface UpdateConnectionProfileInput {
  profileId: string;
  profileDisplayName: string;
  sourceDisplayName?: string;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  sshAuthMethod?: "password" | "privateKey";
}

export interface ISourceServerManagementService {
  readonly onDidChangeState: Event<SourceServerManagementStateDelta>;
  readonly onDidChangeDirectory: Event<SourceServerManagementDirectoryDelta>;
  /** Connection/update log append notifications from the Desktop Host; history is kept by the in-Host memory owner. */
  readonly onDidAppendOperationLog?: Event<SourceServerOperationLog>;
  /** Request fresh statistics on explicit page entry/refresh; event-driven refreshes only read the existing projection, avoiding feedback polling. */
  getSnapshot(
    options?: SourceServerManagementSnapshotRequest,
  ): Promise<SourceServerManagementSnapshot>;
  getRecentOperationLogs(profileId: string): Promise<SourceServerOperationLog[]>;
  connectProfile(
    profileId: string,
    options?: { retainedOnly?: boolean },
  ): Promise<SourceServerManagementSnapshot>;
  confirmIdentityChange(profileId: string): Promise<SourceServerManagementSnapshot>;
  /**
   * Appends the unknown SSH host key the user accepted for this profile to known_hosts. Only the fingerprint the last
   * connect attempt observed is accepted; the caller connects again afterwards.
   */
  trustHostKey(profileId: string, fingerprint: string): Promise<SourceServerManagementSnapshot>;
  disconnectSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  ensureConversationWorkspace(sourceServerId: string): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  updateSource(input: SourceServerUpdateRequest): Promise<SourceServerManagementSnapshot>;
  /**
   * Stop the remote service on the device (RDLC-01): the Host disconnects and drops the resume
   * intent first, then runs `stop --wait` remotely.
   * The device stays disconnected after both success and failure; failure throws an error with a code. Exposed to the Desktop Renderer only.
   */
  stopSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  /**
   * Restart the remote service on the device (RDLC-01): the Host registers a lifecycle operation
   * flight (shown as connecting meanwhile), runs `restart` remotely, and on success follows the
   * existing connect flow and emits reconnect. Failure throws an error with a code. Exposed to the Desktop Renderer only.
   */
  restartSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  /**
   * Read the running tasks on the device before stop / restart confirmation (RDLC-01); routing
   * and credential rules match the two methods above. When the device provides no trusted
   * listing, returns `{ available: false }` rather than "no tasks"; throws `credentials-required`
   * when credentials cannot be obtained silently. Exposed to the Desktop Renderer only.
   */
  getSourceRunningTasks(sourceServerId: string): Promise<SourceServerRunningTasksResult>;
  renameSource(
    sourceServerId: string,
    displayName: string,
  ): Promise<SourceServerManagementSnapshot>;
  renameProfile(profileId: string, displayName: string): Promise<SourceServerManagementSnapshot>;
  updateProfile(input: UpdateConnectionProfileInput): Promise<SourceServerManagementSnapshot>;
  setPreferredProfile(
    sourceServerId: string,
    profileId: string,
  ): Promise<SourceServerManagementSnapshot>;
  removeProfile(profileId: string): Promise<SourceServerManagementSnapshot>;
  removeSourceServer(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  getMigrationReport(sourceServerId: string): Promise<SourceServerMigrationReport>;
  exportMigrationReport(sourceServerId: string): Promise<string>;
  abandonWorkspaceMigration(
    sourceServerId: string,
    workspacePath: string,
    migrationId: string,
  ): Promise<SourceServerMigrationReport>;
  retryWorkspaceMigration(
    sourceServerId: string,
    workspacePath: string,
    migrationId: string,
  ): Promise<SourceServerMigrationReport>;
}

export const ISourceServerManagementService =
  createServiceDescriptor<ISourceServerManagementService>(ServiceChannels.SourceServerManagement);
